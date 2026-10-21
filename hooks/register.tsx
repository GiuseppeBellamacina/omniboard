import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, BgTask, Plan, SessionStats, Step } from '../types'
import { MARK, layout, svgSource, textChain } from './graph'
import { allowed, applyEdit, describe, isComplete, mark, newPlan, noteFor, progress } from './plan'
import type { Edit } from './plan'
import { elapsed, keyOf, money, projectName, rowOf, tokens, upsert, usageTokens } from './stats'

const planA = atom({ plugin: 'omniboard', key: 'plan' } as const, null)
const notesA = atom({ plugin: 'omniboard', key: 'notes' } as const, [])
const agentsA = atom({ plugin: 'omniboard', key: 'agents' } as const, [])
const tasksA = atom({ plugin: 'omniboard', key: 'tasks' } as const, [])
const sessionA = atom({ plugin: 'omniboard', key: 'session' } as const, null)
const expandedA = atom({ plugin: 'omniboard', key: 'expanded' } as const, false)
const editingA = atom({ plugin: 'omniboard', key: 'editing' } as const, null)
const tickA = atom({ plugin: 'omniboard', key: 'tick' } as const, 0)
const boardA = atom({ plugin: 'omniboard', key: 'board' } as const, null)
const refusedA = atom({ plugin: 'omniboard', key: 'refused' } as const, null)
const composingA = atom({ plugin: 'omniboard', key: 'composing' } as const, false)

const TOOL = 'mcp__omniboard__plan'
const PANE = 'omniboard-plan'

// The guidance lives in the tool's description: it reaches the model even where another plugin keeps
// system-prompt hooks from running. Fixed text, so the prompt cache keeps it.
const TOOL_SPEC = {
  name: 'plan',
  description: `The user's live checklist of your plan, shown above the prompt and in their board. Use it whenever you carry out an approved plan or any task of three or more steps:
- first call action "set" with a short title and the steps in order. Steps that run at the same time (for example subagents you start together) go as an inner list: ["Read the code", ["Write the API", "Write the UI"], "Test"]; they get ids like "2a" and "2b";
- call "start" with a step id before working on it and "done" right after finishing it;
- when the work calls for it, change the plan instead of drifting from it: "insert" a new step (after a step id, or at the end with no "after"), "add" a micro-step after a step id, "edit" a step's text, "skip" or "remove" a step that has not started, "restore" a skipped one, "move" a pending step "before" another (or to the end). Finished steps are locked, and steps the user added or changed are theirs: ask them before changing those;
- the user can add, rename, skip or reorder steps while you work: a note tells you, and every result of this tool shows the current plan ("get" reads it). Follow the plan as the user left it, including the steps they added.
Never mark a step done that you did not complete.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'start', 'done', 'add', 'insert', 'edit', 'skip', 'restore', 'remove', 'move', 'get'] },
      title: { type: 'string' },
      steps: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      id: { type: 'string', description: 'Step id, as listed in the plan (e.g. "3", "3.1", "2a").' },
      after: { type: 'string', description: 'For "add" and "insert": the step id the new step follows.' },
      before: { type: 'string', description: 'For "move": the step id to put it before; leave out to move it to the end.' },
      text: { type: 'string', description: 'For "add", "insert" and "edit": the step\'s text.' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

let ticker: { cancel: () => void } | undefined
let liveTimer: { cancel: () => void } | undefined

async function dataDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home}/.claude/omniboard`
}

// ---- notes for Claude -------------------------------------------------------------------------

/** Takes the person's unread edits as one note for Claude, or nothing. */
async function takeNotes($: EngineInterface): Promise<string | undefined> {
  const notes = await read($, notesA)
  if (notes.length === 0) return undefined
  await update($, notesA, () => [])
  scheduleLive($)
  return noteFor(notes, await read($, planA))
}

async function applyUserEdit($: EngineInterface, edit: Edit) {
  const plan = await read($, planA)
  if (!plan) return void (await update($, refusedA, () => 'There is no plan to change.'))
  const out = applyEdit(plan, edit)
  if ('error' in out) {
    await update($, refusedA, () => out.error)
  } else {
    await update($, planA, () => out.plan)
    await update($, notesA, n => [...n, out.note])
    await update($, refusedA, () => null)
  }
  await update($, editingA, () => null)
  scheduleLive($)
}

// ---- Claude's tool ---------------------------------------------------------------------------

async function answerTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const now = await $.clock.now()
  const action = String(input.action ?? 'get')
  let plan = await read($, planA)
  let problem = ''
  if (action === 'set') {
    const steps = Array.isArray(input.steps) ? input.steps.map(s => (Array.isArray(s) ? s.map(String) : String(s))) : []
    if (steps.length === 0) problem = 'Give the steps as a list of strings.'
    else plan = newPlan(String(input.title ?? 'Plan'), steps, now)
  } else if (action !== 'get') {
    if (!plan) problem = 'There is no plan yet: call this tool with action "set" first.'
    else {
      const id = String(input.id ?? '')
      const text = String(input.text ?? '')
      const after = typeof input.after === 'string' && input.after ? input.after : null
      const edit: Edit | undefined =
        action === 'add' ? { op: 'add', after: after ?? '', text }
        : action === 'insert' ? { op: 'insert', after, text }
        : action === 'edit' ? { op: 'edit', id, text }
        : action === 'skip' || action === 'restore' || action === 'remove' ? { op: action, id }
        : action === 'move' ? { op: 'move', id, before: typeof input.before === 'string' && input.before ? input.before : null }
        : undefined
      const out = edit ? applyEdit(plan, edit, 'claude') : action === 'start' || action === 'done' ? mark(plan, id, action === 'done' ? 'done' : 'running', now) : { error: `Unknown action "${action}".` }
      if ('error' in out) problem = out.error
      else plan = out.plan
    }
  }
  if (plan) await update($, planA, () => plan)
  scheduleLive($)
  const note = await takeNotes($)
  return [problem && `Not done: ${problem}`, note ?? (plan ? describe(plan) : 'No plan yet.')].filter(Boolean).join('\n\n')
}

// ---- agents and background tasks ----------------------------------------------------------------

async function track($: EngineInterface) {
  const busy = (await read($, agentsA)).some(a => a.status === 'running') || (await read($, tasksA)).some(t => t.status === 'running')
  if (busy && !ticker) ticker = $.clock.every(5000, () => void update($, tickA, n => n + 1))
  if (!busy && ticker) {
    ticker.cancel()
    ticker = undefined
  }
  scheduleLive($)
}

async function endTask($: EngineInterface, id: string, failed: boolean) {
  const now = await $.clock.now()
  const close = <T extends { id: string; status: string }>(list: T[]) =>
    list.map(x => (x.id === id && x.status === 'running' ? { ...x, status: failed ? ('failed' as const) : ('done' as const), endedAt: now } : x))
  await update($, tasksA, close)
  await update($, agentsA, close)
  await track($)
}

// ---- statistics -----------------------------------------------------------------------------------

async function recordTurn($: EngineInterface, durationMs: number, used: number) {
  const usage = await $.session.usage()
  const key = keyOf(await $.session.id(), usage.startedAt)
  const cost = usage.cost?.usd ?? 0
  const current = await read($, sessionA)
  const repo = await $.session.repo().catch(() => null)
  const base: SessionStats =
    current && current.key === key
      ? current
      : { key, started: usage.startedAt, project: projectName(repo?.root ?? (await $.session.cwd())), title: '', model: '', cost, lastCost: 0, tokens: 0, agentMs: 0, turns: 0 }
  const next: SessionStats = {
    ...base,
    model: (await $.session.model().catch(() => '')) || base.model,
    lastCost: Math.max(0, cost - base.cost),
    cost,
    tokens: base.tokens + used,
    agentMs: base.agentMs + durationMs,
    turns: await $.session.turns(),
  }
  await update($, sessionA, () => next)
  const file = `${await dataDir($)}/sessions.csv`
  const csv = await $.fs.read(file).catch(() => '')
  await $.fs.write(file, upsert(csv, next.key, rowOf(next)))
  scheduleLive($)
}

// ---- the browser board ----------------------------------------------------------------------------

function scheduleLive($: EngineInterface) {
  liveTimer?.cancel()
  liveTimer = $.clock.after(400, () => void writeLive($))
}

async function writeLive($: EngineInterface) {
  if (!(await read($, boardA))) return
  const plan = await read($, planA)
  const graph = plan && layout(plan)
  const live = {
    at: await $.clock.now(),
    plan: plan && { ...plan, steps: plan.steps.map(s => ({ ...s, can: allowed(plan, s) })), progress: progress(plan) },
    graph: graph && { ...graph, boxes: graph.boxes.map(b => ({ id: b.step.id, x: b.x, y: b.y })) },
    agents: await read($, agentsA),
    tasks: await read($, tasksA),
    session: await read($, sessionA),
    refused: await read($, refusedA),
    // Edits the person made that Claude has not read yet.
    pending: (await read($, notesA)).length,
  }
  await $.fs.write(`${await dataDir($)}/live.json`, JSON.stringify(live))
}

async function openUrl($: EngineInterface, url: string) {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', url] : [mac ? 'open' : 'xdg-open', url]).catch(() => undefined)
}

const isEdit = (v: unknown): v is Edit => {
  const e = v as Record<string, unknown>
  const s = (k: string) => typeof e[k] === 'string'
  switch (e?.op) {
    case 'add': return s('after') && s('text')
    case 'edit': return s('id') && s('text')
    case 'skip': case 'restore': case 'remove': return s('id')
    case 'move': return s('id') && (e.before === null || s('before'))
    default: return false
  }
}

// Runs the board server for as long as the session (or the server's own idle timeout) lasts.
async function serve($: EngineInterface) {
  const dir = await dataDir($)
  await writeLive($)
  const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/server/board-server.mjs`, '--dir', dir, '--page', `${$.plugin.root}/board/index.html`] })
  let buffer = ''
  try {
    for await (const piece of child) {
      if (piece.stream !== 'stdout') continue
      buffer += piece.text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('READY ')) {
          const url = line.slice(6)
          await update($, boardA, () => url)
          await writeLive($)
          await openUrl($, url)
        } else if (line.startsWith('EDIT ')) {
          const edit = (() => { try { return JSON.parse(line.slice(5)) as unknown } catch { return undefined } })()
          if (isEdit(edit)) await applyUserEdit($, edit)
        }
      }
    }
  } finally {
    await update($, boardA, () => null)
  }
}

async function openBoard($: EngineInterface) {
  const url = await read($, boardA)
  // The address outlives the server when the module reloads: reuse it only if the server still answers.
  if (url && (await $.http.fetch(`${url}api/live`).then(r => r.ok, () => false))) return openUrl($, url)
  await update($, boardA, () => null)
  void serve($).catch(() => $.ui.toast('omniboard: the board server could not start (is Node.js installed?).'))
}

// ---- the pane ------------------------------------------------------------------------------------

/** Up and down are moves before a sibling: the step two places down, or the end of the level. */
function moveOf(plan: Plan, step: Step, dir: -1 | 1): Edit {
  const level = plan.steps.filter(s => s.parent === step.parent)
  const i = level.indexOf(step)
  const before = dir === -1 ? level[i - 1] : level[i + 2]
  return { op: 'move', id: step.id, before: before ? before.id : null }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(TOOL_SPEC)
    await $.command.register({ name: 'checklist', description: 'Open Claude\'s plan as a checklist you can edit' })
    await $.command.register({ name: 'board', description: 'Open the omniboard in the browser: live plan, agents, statistics' })
    await $.command.register({ name: 'board-import', description: 'Add past Claude Code sessions to the omniboard statistics' })
    const expanded = await $.store.get('expanded')
    await update($, expandedA, () => expanded === true)
    // A (re)load starts with no server: the one an earlier load ran died with it.
    await update($, boardA, () => null)
    return next(e)
  })

  // Claude's own checklist tool never asks the user for permission.
  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' as const }))

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return { result: await answerTool($, e as unknown as Record<string, unknown>) }

    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      await update($, agentsA, list => list.map(a => (a.id === e.agentId ? { ...a, tools: a.tools + 1, lastTool: String(e.tool) } : a)))
    }
    const ran = await next(e)
    const result = (ran as { result?: Record<string, unknown> }).result
    const context: string[] = []

    if (e.tool === 'ExitPlanMode' && typeof result?.plan === 'string' && result.plan) {
      context.push('The plan is approved. Before you start, call mcp__omniboard__plan with action "set": a short title and its top-level steps in order.')
    }
    // Claude's own todo list stands in for a plan only while it has not set one with omniboard's tool.
    const shown = await read($, planA)
    if (e.tool === 'TodoWrite' && Array.isArray(result?.newTodos) && (!shown || shown.title === 'Todo')) {
      const todos = result.newTodos as { content: string; status: string }[]
      const plan = newPlan('Todo', todos.map(t => t.content), now)
      plan.steps.forEach((s, i) => (s.status = todos[i]?.status === 'completed' ? 'done' : todos[i]?.status === 'in_progress' ? 'running' : 'pending'))
      await update($, planA, () => plan)
    }
    // Any shell tool (Bash, PowerShell) that moved its command to the background reports the task's id.
    const background =
      typeof result?.backgroundTaskId === 'string'
        ? { id: result.backgroundTaskId, kind: 'shell' as const, label: String((e as { command?: string }).command ?? e.tool) }
        : e.tool === 'Monitor' && typeof result?.taskId === 'string'
          ? { id: result.taskId, kind: 'monitor' as const, label: String((e as { description?: string }).description ?? 'monitor') }
          : String(e.tool) === 'Workflow' && typeof result?.taskId === 'string'
            ? { id: result.taskId, kind: 'workflow' as const, label: String(result.workflowName ?? 'workflow') }
            : undefined
    if (background) {
      const task: BgTask = { ...background, label: background.label.replace(/\s+/g, ' ').slice(0, 120), status: 'running', startedAt: now }
      await update($, tasksA, list => [...list.filter(t => t.id !== task.id), task].slice(-30))
      await track($)
    }

    // The person's plan edits reach Claude here, on its next action, whatever tool it is. A denied call carries
    // no context, so they wait for the next one.
    if (ran.deny !== undefined) return ran
    if (e.agentId === undefined) {
      const note = await takeNotes($)
      if (note) context.push(note)
    }
    return context.length ? { ...ran, context: [...(ran.context ?? []), ...context] } : ran
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    if (out.agentId) {
      const run: AgentRun = {
        id: out.agentId,
        type: e.subagentType || 'general',
        description: e.description,
        model: out.model,
        parentId: e.parentAgentId,
        background: e.background,
        status: 'running',
        startedAt: await $.clock.now(),
        tokens: 0,
        tools: 0,
      }
      await update($, agentsA, list => [...list.filter(a => a.id !== run.id), run].slice(-40))
      await track($)
    }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const used = e.usage ? usageTokens(e.usage) : 0
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agentsA, list =>
        list.map(a => (a.id === e.agentId ? { ...a, tokens: a.tokens + used, status: e.reason === 'answer' ? ('done' as const) : ('failed' as const), endedAt: now } : a)),
      )
      // Subagents' tokens count towards the session; their cost is already in the session's cost.
      await update($, sessionA, s => (s ? { ...s, tokens: s.tokens + used } : s))
      await track($)
    } else {
      await recordTurn($, e.durationMs, used)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) await update($, agentsA, list => list.map(a => (a.id === e.agentId ? { ...a, status: 'running' as const } : a)))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1]
      const status = /<status>([^<]+)<\/status>/.exec(e.text)?.[1] ?? ''
      if (id) await endTask($, id.trim(), /fail|kill|error|cancel/i.test(status))
    }
    if (e.origin.kind === 'composer' && !e.command) {
      const title = e.text.trim().split('\n')[0]!.slice(0, 80)
      await update($, sessionA, s => (s && !s.title ? { ...s, title } : s))
    }
    if (e.command !== undefined) return next(e)
    const notes = await read($, notesA)
    if (notes.length === 0) return next(e)
    // Edits made while Claude was idle ride on the next prompt that enters.
    const out = await next({ ...e, context: [...(e.context ?? []), noteFor(notes, await read($, planA))] })
    if (!('drop' in out && out.drop)) {
      await update($, notesA, n => n.slice(notes.length))
      scheduleLive($)
    }
    return out
  })

  // At each stop the engine lists what still runs in the background: anything else has ended.
  on('classic.Stop', async ($, e, next) => {
    const live = new Set((e.background_tasks ?? []).filter(t => t.status === 'running').map(t => t.id))
    const now = await $.clock.now()
    await update($, tasksA, list => list.map(t => (t.status === 'running' && !live.has(t.id) ? { ...t, status: 'done' as const, endedAt: now } : t)))
    await track($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, planA, () => null)
      await update($, editingA, () => null)
      await update($, refusedA, () => null)
      await update($, notesA, () => [])
      await update($, agentsA, () => [])
      await update($, tasksA, () => [])
    }
    return next(e)
  })

  on('command.run', { command: 'checklist' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Plan', focus: true })
    return {}
  })

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)
    const url = await read($, boardA)
    return { text: url ? `omniboard: ${url}` : 'omniboard: starting the board in your browser…' }
  })

  on('command.run', { command: 'board-import' }, async $ => {
    const dir = await dataDir($)
    const usage = await $.session.usage()
    const skip = keyOf(await $.session.id(), usage.startedAt).slice(0, 8)
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/import.mjs`, '--dir', dir, '--skip', skip], { timeoutMs: 600_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    return { text: run.exitCode === 0 ? run.stdout.trim() : `omniboard: import failed. ${run.stderr.trim().slice(0, 400)}` }
  })

  // ---- band above the prompt ----------------------------------------------------------------------
  // The command list opens where the band sits: the band steps aside while the box holds a slash command.
  // Written only when that changes, so typing costs nothing.
  const slash = (text: string) => text.trimStart().startsWith('/')
  on('prompt.edit', async ($, e, next) => {
    const out = await next(e)
    if (slash(out.text) !== (await read($, composingA))) await update($, composingA, () => slash(out.text))
    return out
  })
  on('prompt.change', async ($, e, next) => {
    if (slash(e.text) !== (await read($, composingA))) await update($, composingA, () => slash(e.text))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, composingA))) return next(e)
    const plan = await read($, planA)
    const agents = await read($, agentsA)
    const tasks = await read($, tasksA)
    const session = await read($, sessionA)
    const expanded = await read($, expandedA)
    await read($, tickA)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns

    const runningAgents = agents.filter(a => a.status === 'running')
    const runningTasks = tasks.filter(t => t.status === 'running')
    const unfinished = plan?.steps.some(s => s.status === 'pending' || s.status === 'running')
    // Shown only while a plan has open steps (Claude Code also draws its "From the plugin" label above any band,
    // its own menus included). Agents and background tasks show in it while that plan runs.
    if (!unfinished) return next(e)
    const below = await next(e).catch(() => undefined)
    const p = plan && progress(plan)
    const toggle = async () => {
      const value = !expanded
      await update($, expandedA, () => value)
      await $.store.set('expanded', value)
    }
    const openPlan = () => $.ui.open({ id: PANE, title: 'Plan', focus: true })
    const stats = session ? `${money(session.cost)} · ${elapsed(session.agentMs)} · ${tokens(session.tokens)} tok` : 'no turn yet'

    // One row: progress (count and squares; the steps live in the checklist and the board), what runs, the totals,
    // then the buttons. Claude Code already names the plugin above it.
    const filled = p ? Math.round((p.done / Math.max(1, p.total)) * 8) : 0
    const summary = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {p && <Text>▣ {p.done}/{p.total}</Text>}
        {p && <Text color="success">{'■'.repeat(filled)}</Text>}
        {p && <Text dimColor>{'□'.repeat(8 - filled)}</Text>}
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            {'  │  '}
            {runningAgents.length || runningTasks.length ? `● ${runningAgents.length} agent${runningAgents.length === 1 ? '' : 's'} · ⧗ ${runningTasks.length} bg   │   ` : ''}
            {stats}
          </Text>
        </Box>
        <Button key="board" plain label="Board" onPress={() => openBoard($)} />
        {plan && <Button key="plan" plain label="Plan" onPress={openPlan} />}
        <Button key="toggle" plain label={expanded ? '▴' : '▾'} onPress={toggle} />
      </Box>
    )

    const details = expanded && (
      <Box flexDirection="column">
        {plan && (
          <Text wrap="truncate-end">
            <Text bold>Plan</Text> · {plan.title}
          </Text>
        )}
        {agents.length > 0 && <Text bold>Agents</Text>}
        {[...runningAgents, ...agents.filter(a => a.status !== 'running').slice(-2)].slice(0, 5).map(a => (
          <Box key={`agent-${a.id}`} flexDirection="row" gap={1}>
            <Text color={a.status === 'running' ? 'warning' : a.status === 'done' ? 'success' : 'error'}>{a.status === 'running' ? ' ●' : a.status === 'done' ? ' ✓' : ' ✗'}</Text>
            <Text dimColor>{a.type.padEnd(9).slice(0, 9)}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">{a.description}</Text>
            </Box>
            <Text dimColor>
              {elapsed((a.endedAt ?? now) - a.startedAt)} · {tokens(a.tokens)} tok{a.status === 'running' && a.lastTool ? ` · ${a.lastTool}` : ''}
            </Text>
          </Box>
        ))}
        {runningTasks.length > 0 && <Text bold>Background</Text>}
        {runningTasks.slice(0, 3).map(t => (
          <Box key={`task-${t.id}`} flexDirection="row" gap={1}>
            <Text color="warning"> ⧗</Text>
            <Text dimColor>{t.kind.padEnd(9)}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">{t.label}</Text>
            </Box>
            <Text dimColor>{elapsed(now - t.startedAt)}</Text>
          </Box>
        ))}
        {session && (
          <Text dimColor wrap="truncate-end">
            Session · last turn {money(session.lastCost)} · {session.turns} turns
          </Text>
        )}
      </Box>
    )

    const mine = (
      <Box flexDirection="column" width={width}>
        {summary}
        {details}
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  // ---- the plan pane ----------------------------------------------------------------------------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const plan = await read($, planA)
    const editing = await read($, editingA)
    const refused = await read($, refusedA)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    if (!plan) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No plan yet. When Claude starts a plan or a task of several steps, it shows up here as a checklist you can edit.</Text>
        </Box>
      )
    }
    const p = progress(plan)
    const Input = 'Input' in table ? table.Input : undefined
    const graph =
      'Svg' in table ? (
        <table.Svg source={svgSource(plan)} alt={`Plan graph: ${p.done} of ${p.total} steps done`} isInteractive />
      ) : (
        <Text>{textChain(plan)}</Text>
      )
    const edit = (x: Edit) => applyUserEdit($, x)
    const openField = (id: string, mode: 'add' | 'edit') => update($, editingA, () => ({ id, mode }))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold wrap="truncate-end">
          {plan.title} · {p.done}/{p.total}
        </Text>
        {graph}
        {refused && <Text color="error">{refused}</Text>}
        <Box flexDirection="column">
          {plan.steps.map(s => {
            const can = allowed(plan, s)
            return (
              <Box key={`step-${s.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={s.status === 'done' ? 'success' : s.status === 'running' ? 'warning' : undefined} dimColor={s.status === 'skipped'}>
                    {s.parent ? '   ' : ''}
                    {MARK[s.status]} {s.id}
                  </Text>
                  <Box flexGrow={1}>
                    <Text wrap="truncate-end" dimColor={s.status === 'done' || s.status === 'skipped'}>
                      {s.text}
                      {s.group ? ' · parallel' : ''}
                      {s.byUser ? ' · added by you' : s.editedByUser ? ' · edited by you' : ''}
                    </Text>
                  </Box>
                  {can.up && <Button key={`up-${s.id}`} plain label="↑" onPress={() => edit(moveOf(plan, s, -1))} />}
                  {can.down && <Button key={`down-${s.id}`} plain label="↓" onPress={() => edit(moveOf(plan, s, 1))} />}
                  {can.add && Input && <Button key={`add-${s.id}`} plain label="+ after" onPress={() => openField(s.id, 'add')} />}
                  {can.edit && Input && <Button key={`edit-${s.id}`} plain label="edit" onPress={() => openField(s.id, 'edit')} />}
                  {can.skip && <Button key={`skip-${s.id}`} plain label="skip" onPress={() => edit({ op: 'skip', id: s.id })} />}
                  {can.restore && <Button key={`restore-${s.id}`} plain label="restore" onPress={() => edit({ op: 'restore', id: s.id })} />}
                  {can.remove && s.byUser && <Button key={`remove-${s.id}`} plain label="✕" onPress={() => edit({ op: 'remove', id: s.id })} />}
                </Box>
                {Input && editing?.id === s.id && (
                  <Input
                    key={`field-${s.id}-${editing.mode}`}
                    label={editing.mode === 'add' ? `New step after ${s.id}:` : `Step ${s.id}:`}
                    value={editing.mode === 'edit' ? s.text : ''}
                    submitLabel={editing.mode === 'add' ? 'add' : 'save'}
                    autoFocus
                    onSubmit={value => edit(editing.mode === 'add' ? { op: 'add', after: s.id, text: value } : { op: 'edit', id: s.id, text: value })}
                  />
                )}
              </Box>
            )
          })}
        </Box>
        <Text dimColor>{isComplete(plan) ? 'This plan is complete: it stays as it ended.' : 'Done sections are locked. Claude reads every change at its next step.'}</Text>
      </Box>
    )
  })
}
