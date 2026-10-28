import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, BgTask, Plan, SessionStats } from '../types'
import { layout } from './graph'
import { allowed, applyEdit, describe, mark, newPlan, noteFor, progress } from './plan'
import type { Edit } from './plan'
import { elapsed, keyOf, money, projectName, rowOf, tokens, upsert, usageTokens } from './stats'

const planA = atom({ plugin: 'omniboard', key: 'plan' } as const, null)
const notesA = atom({ plugin: 'omniboard', key: 'notes' } as const, [])
const agentsA = atom({ plugin: 'omniboard', key: 'agents' } as const, [])
const tasksA = atom({ plugin: 'omniboard', key: 'tasks' } as const, [])
const sessionA = atom({ plugin: 'omniboard', key: 'session' } as const, null)
const boardA = atom({ plugin: 'omniboard', key: 'board' } as const, null)
const refusedA = atom({ plugin: 'omniboard', key: 'refused' } as const, null)
const composingA = atom({ plugin: 'omniboard', key: 'composing' } as const, false)

const TOOL = 'mcp__omniboard__plan'

// The guidance lives in the tool's description: it reaches the model even where another plugin keeps
// system-prompt hooks from running. Fixed text, so the prompt cache keeps it.
const TOOL_SPEC = {
  name: 'plan',
  description: `The user's live checklist of your plan, shown above the prompt and in their board. Use it whenever you carry out an approved plan or any task of three or more steps:
- first call action "set" with a short title and the steps in order. Steps that run at the same time (for example subagents you start together) go as an inner list: ["Read the code", ["Write the API", "Write the UI"], "Test"]; they get ids like "2a" and "2b";
- call "start" with a step id before working on it and "done" right after finishing it;
- when the work calls for it, change the plan instead of drifting from it: "insert" a new step (after a step id, or at the end with no "after"), "add" a micro-step after a step id, "edit" a step's text, "skip" or "remove" a step that has not started, "restore" a skipped one, "move" a pending step "before" another (or to the end). Finished steps are locked, and steps the user added or changed are theirs: ask them before changing those;
- "stop" ends the whole plan where it is, every open step skipped: only when the user asks to stop or drop it;
- the user can add, rename, skip or reorder steps while you work: a note tells you, and every result of this tool shows the current plan ("get" reads it). Follow the plan as the user left it, including the steps they added.
Never mark a step done that you did not complete.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'start', 'done', 'add', 'insert', 'edit', 'skip', 'restore', 'remove', 'move', 'stop', 'get'] },
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
        : action === 'stop' ? { op: 'stop' }
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

async function endTask($: EngineInterface, id: string, failed: boolean) {
  const now = await $.clock.now()
  const close = <T extends { id: string; status: string }>(list: T[]) =>
    list.map(x => (x.id === id && x.status === 'running' ? { ...x, status: failed ? ('failed' as const) : ('done' as const), endedAt: now } : x))
  await update($, tasksA, close)
  await update($, agentsA, close)
  scheduleLive($)
}

// ---- statistics -----------------------------------------------------------------------------------

async function recordTurn($: EngineInterface, durationMs: number, used: number) {
  const usage = await $.session.usage()
  const key = keyOf(await $.session.id(), usage.startedAt)
  const cost = usage.cost?.usd ?? 0
  const current = await read($, sessionA)
  const base: SessionStats =
    current && current.key === key
      ? current
      : { key, started: usage.startedAt, project: await project($), title: '', model: '', cost, lastCost: 0, tokens: 0, agentMs: 0, turns: 0 }
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
  liveTimer = $.clock.after(400, () => void Promise.all([writeLive($), savePlan($)]))
}

// ---- plans kept past the session ----------------------------------------------------------------
// The session's state ends with it: each plan is also kept on disk under its session's id, so reopening
// the session (or /board-restore in another) brings it back.

type Saved = Record<string, { plan: Plan; project: string; savedAt: number }>
let lastSaved = ''
/** The session the plan in state belongs to: /resume inside a running process moves to another id. */
let sessionOf = ''
const isOpen = (plan: Plan) => plan.steps.some(s => s.status === 'pending' || s.status === 'running')

async function readSaved($: EngineInterface): Promise<Saved> {
  try {
    return JSON.parse(await $.fs.read(`${await dataDir($)}/plans.json`)) as Saved
  } catch {
    return {}
  }
}

async function project($: EngineInterface) {
  const repo = await $.session.repo().catch(() => null)
  return projectName(repo?.root ?? (await $.session.cwd()))
}

async function savePlan($: EngineInterface) {
  const plan = await read($, planA)
  const json = plan ? JSON.stringify(plan) : ''
  if (!plan || !sessionOf || json === lastSaved) return
  lastSaved = json
  const all = await readSaved($)
  all[sessionOf] = { plan, project: await project($), savedAt: await $.clock.now() }
  // shortcut: keeps the 30 most recently changed plans, plenty to come back to any recent session; older ones go.
  const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 30))
  await $.fs.write(`${await dataDir($)}/plans.json`, JSON.stringify(kept))
}

/**
 * /resume inside a running session swaps the conversation under another id with no new session.start (and the
 * SessionStart hook can be skipped by another plugin): at each message, a new id brings its own plan, or none.
 */
async function followSession($: EngineInterface) {
  const id = await $.session.id()
  if (id === sessionOf) return
  const was = sessionOf
  sessionOf = id
  // A /clear also moves to a new id; session.end has already emptied the state for it.
  if (!was) return
  await update($, notesA, () => [])
  await update($, agentsA, () => [])
  await update($, tasksA, () => [])
  const saved = (await readSaved($))[id]
  if (saved) await restorePlan($, saved.plan, 'the session was resumed, and its plan is back: go on from its first open step')
  else {
    await update($, planA, () => null)
    lastSaved = ''
  }
  scheduleLive($)
}

/** Puts a saved plan back; Claude reads that it did with the next message or action. */
async function restorePlan($: EngineInterface, plan: Plan, note: string) {
  const json = JSON.stringify(plan)
  if (json === JSON.stringify(await read($, planA))) return
  lastSaved = json
  await update($, planA, () => plan)
  await update($, refusedA, () => null)
  if (isOpen(plan)) await update($, notesA, () => [note])
  scheduleLive($)
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
    case 'stop': return true
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(TOOL_SPEC)
    await $.command.register({ name: 'board', description: 'Open the omniboard in the browser: live plan you can edit, agents, statistics' })
    await $.command.register({ name: 'board-import', description: 'Add past Claude Code sessions to the omniboard statistics' })
    await $.command.register({ name: 'board-restore', description: 'Bring back the latest unfinished omniboard plan of this project from another session' })
    // A (re)load starts with no server: the one an earlier load ran died with it.
    await update($, boardA, () => null)
    // A reopened session (--resume keeps its id) gets its plan back; a module reload still holds it.
    sessionOf = await $.session.id()
    const saved = (await readSaved($))[sessionOf]
    if (saved && !(await read($, planA))) await restorePlan($, saved.plan, 'the session was closed and reopened, and its plan is back: go on from its first open step')
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
      scheduleLive($)
    }
    // A task Claude stops sends no notice; the stop's own input names it.
    if (String(e.tool) === 'TaskStop' && ran.deny === undefined) {
      const input = e as unknown as { task_id?: unknown; shell_id?: unknown }
      const stopped = typeof input.task_id === 'string' ? input.task_id : typeof input.shell_id === 'string' ? input.shell_id : ''
      if (stopped) await endTask($, stopped, false)
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
      scheduleLive($)
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
      scheduleLive($)
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
    await followSession($)
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

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, planA, () => null)
      await update($, refusedA, () => null)
      await update($, notesA, () => [])
      await update($, agentsA, () => [])
      await update($, tasksA, () => [])
    }
    return next(e)
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

  // A new session that carries on earlier work: the latest unfinished plan of the same project, from another session.
  on('command.run', { command: 'board-restore' }, async $ => {
    const current = await read($, planA)
    if (current && isOpen(current)) {
      const p = progress(current)
      return { text: `omniboard: this session already has an unfinished plan, "${current.title}" (${p.done}/${p.total} done). Stop it from the board first to bring back another one.` }
    }
    const id = await $.session.id()
    const here = await project($)
    const others = Object.entries(await readSaved($))
      .filter(([key, s]) => key !== id && isOpen(s.plan))
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
    // The folder a session runs in can change (a window opened on the parent folder): another project's plan is the fallback.
    const found = others.find(([, s]) => s.project === here) ?? others[0]
    if (!found) return { text: 'omniboard: no unfinished plan saved from another session.' }
    const { plan, savedAt, project: from } = found[1]
    await restorePlan($, plan, `the user brought back "${plan.title}", a plan left unfinished in an earlier session: go on from its first open step`)
    const p = progress(plan)
    return { text: `omniboard: restored "${plan.title}" (${p.done}/${p.total} done) from ${from === here ? 'this project' : `the project ${from}`}, last changed ${new Date(savedAt).toLocaleString()}. Claude reads it with your next message.` }
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

  // One row while a plan has open steps: its progress, the session's totals and the button to the board.
  // Claude Code draws its "From the plugin" label above any band, its own menus included: so nothing at other times.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, composingA))) return next(e)
    const plan = await read($, planA)
    if (!plan?.steps.some(s => s.status === 'pending' || s.status === 'running')) return next(e)
    const session = await read($, sessionA)
    const below = await next(e).catch(() => undefined)
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = progress(plan)
    const filled = Math.round((p.done / Math.max(1, p.total)) * 8)
    const mine = (
      <Box flexDirection="row" alignItems="center" gap={1} width={e.props.bodyColumns}>
        <Text>▣ {p.done}/{p.total}</Text>
        <Text color="success">{'■'.repeat(filled)}</Text>
        <Text dimColor>{'□'.repeat(8 - filled)}</Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            {'  │  '}
            {session ? `${money(session.cost)} · ${elapsed(session.agentMs)} · ${tokens(session.tokens)} tok` : 'no turn yet'}
          </Text>
        </Box>
        <Button key="board" plain label="Omniboard" onPress={() => openBoard($)} />
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
}
