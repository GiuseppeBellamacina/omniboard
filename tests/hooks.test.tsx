import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { newPlan } from '../hooks/plan'

const TOOL = 'mcp__omniboard__plan'
const BAND = {
  plugin: 'omniboard',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// The engine beneath the plugin.
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/test', OS: 'Windows_NT' })
  const files: Record<string, string> = {}
  // The session's id: /resume inside the process moves it.
  const ids = { session: '2fdd950f-1234' }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__omniboard__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { startedAt: 500_000, cost: { usd: 1.25 }, context: { window: 200000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: ids.session }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: 'd:\\Codici\\Workspace' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : Promise.reject(new Error('missing'))))
  on('fs.write', (_, e) => ((files[e.path] = e.text), { value: undefined }))
  return { files, clock, ids }
}

// What earlier sessions left in plans.json (the kit's fs keeps paths with backslashes).
const PLANS = 'C:\\Users\\test\\.claude\\omniboard\\plans.json'
const leftover = (sessionId: string, title: string) => {
  const p = newPlan(title, ['Leggere', 'Testare'], 1)
  p.steps[0]!.status = 'done'
  return JSON.stringify({ [sessionId]: { plan: p, project: 'Workspace', savedAt: 1 } })
}

const plan = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result?: unknown; context?: readonly string[] }>

test("Claude's plan tool is allowed without asking and drives the band", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.tool.check({ tool: TOOL, input: { action: 'get' } })).decision).toBe('allow')

  const set = await plan($, { action: 'set', title: 'Rifare auth', steps: ['Leggere', 'Testare', 'Rilasciare'] })
  expect(String(set.result)).toMatch(/Plan: Rifare auth \(0\/3 done\)/)
  await plan($, { action: 'start', id: '1' })
  const done = await plan($, { action: 'done', id: '1' })
  expect(String(done.result)).toMatch(/\[x\] 1 Leggere/)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /▣ 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Testare/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the board gets the background tasks, and an edit made in it reaches Claude exactly once', async ($, on) => {
  // Registered before the engine's catch-all answer, so it is the one that answers PowerShell.
  on('tool.call', { tool: 'PowerShell' } as never, () => ({ result: { stdout: '', backgroundTaskId: 'b304' } }))
  const { files, clock } = engine(on)
  // The board server: it reports its address, then (a second later) an edit made in the page.
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'READY http://127.0.0.1:1/t/\n' }
    await clock.sleep(1000)
    yield { stream: 'stdout', text: 'EDIT {"op":"add","after":"1","text":"Lanciare il lint"}\n' }
    return { value: { code: 0, signal: null } }
  } as never)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  await plan($, { action: 'start', id: '1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'board' })
  await ui.unmount()
  await clock.settle()
  await $.tool.call({ tool: 'PowerShell', command: 'node ticker.js', run_in_background: true } as never)
  await clock.advance(500)
  const liveJson = () => JSON.parse(Object.entries(files).find(([path]) => path.endsWith('live.json'))![1])
  expect(liveJson().tasks.map((t: { label: string; status: string }) => `${t.label}:${t.status}`)).toEqual(['node ticker.js:running'])
  // Stopped by Claude: no notice comes, the stop itself closes it.
  await $.tool.call({ tool: 'TaskStop', task_id: 'b304' } as never)
  await clock.advance(500)
  expect(liveJson().tasks[0].status).toBe('done')
  await clock.advance(1000)

  const first = await $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  expect(first.context?.join('\n')).toMatch(/added step 1\.1 "Lanciare il lint" to step 1/)
  expect(first.context?.join('\n')).toMatch(/\[ \] 1\.1 Lanciare il lint \(added by the user\)/)
  const second = await $.tool.call({ tool: 'Read', file_path: 'y.ts' })
  expect(second.context).toBeUndefined()
})

test('every change of the plan is kept on disk under the session id', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'Rifare auth', steps: ['Leggere', 'Testare'] })
  await plan($, { action: 'done', id: '1' })
  await clock.advance(500)
  const kept = JSON.parse(files[PLANS]!)['2fdd950f-1234']
  expect(kept.project).toBe('Workspace')
  expect(kept.plan.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'pending'])
})

test('a reopened session gets its plan back, and Claude reads that once', async ($, on) => {
  const { files } = engine(on)
  files[PLANS] = leftover('2fdd950f-1234', 'Rifare auth')
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /▣ 1\/2/ })).toBeDefined()
  await ui.unmount()
  const first = await $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  expect(first.context?.join('\n')).toMatch(/closed and reopened/)
  expect(first.context?.join('\n')).toMatch(/\[x\] 1 Leggere/)
  expect((await $.tool.call({ tool: 'Read', file_path: 'y.ts' })).context).toBeUndefined()
})

test('the band closes with its button, and comes back with a new plan or /board band', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'Uno', steps: ['A', 'B'] })
  const show = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
    const found = (await ui.find({ key: 'board' })) !== undefined
    return { ui, found }
  }

  let { ui, found } = await show()
  expect(found).toBe(true)
  await ui.press({ key: 'hide' })
  await ui.unmount()
  ;({ ui, found } = await show())
  expect(found).toBe(false)
  await ui.unmount()

  // A command brings it back at once.
  const board = async (args: string) => ((await $.command.run({ command: 'board', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text
  expect(await board('band')).toMatch(/band above the prompt is back/)
  ;({ ui, found } = await show())
  expect(found).toBe(true)
  await ui.press({ key: 'hide' })
  await ui.unmount()

  // A new plan shows it again.
  await plan($, { action: 'set', title: 'Due', steps: ['C', 'D', 'E'] })
  ;({ ui, found } = await show())
  await ui.unmount()
  expect(found).toBe(true)
})

const restore = async ($: Engine) =>
  ((await $.command.run({ command: 'board-restore', args: '', origin: { kind: 'composer' } } as never)) as { text?: string }).text

test('/board-restore brings back the unfinished plan of this project from another session', async ($, on) => {
  const { files } = engine(on)
  files[PLANS] = leftover('older-session', 'Migrare il db')
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(await restore($)).toMatch(/restored "Migrare il db" \(1\/2 done\) from this project/)
  expect(String((await plan($, { action: 'get' })).result)).toMatch(/Plan: Migrare il db/)
  // Now this session has an unfinished plan of its own: the command says so instead of "nothing found".
  expect(await restore($)).toMatch(/already has an unfinished plan, "Migrare il db"/)
})

test('/board-restore falls back to another project when the folder changed', async ($, on) => {
  const { files } = engine(on)
  files[PLANS] = leftover('older-session', 'Migrare il db').replace('"Workspace"', '"omniboard"')
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(await restore($)).toMatch(/restored "Migrare il db" \(1\/2 done\) from the project omniboard/)
})

test('/resume inside a running session brings that session\'s plan, or none', async ($, on) => {
  const { files, clock, ids } = engine(on)
  on('prompt.submit', (_, e) => e as never)
  files[PLANS] = leftover('resumed-session', 'Rifare auth')
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'Prima', steps: ['a', 'b'] })
  await clock.advance(500)
  ids.session = 'resumed-session'
  await $.prompt.submit({ origin: { kind: 'composer' }, text: 'ciao' } as never)
  expect(String((await plan($, { action: 'get' })).result)).toMatch(/Plan: Rifare auth/)
  // The first session's plan stayed under its own id.
  expect(JSON.parse(files[PLANS]!)['2fdd950f-1234'].plan.title).toBe('Prima')
})

test('Claude ends the plan with "stop" when the user asks', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  await plan($, { action: 'start', id: '1' })
  expect(String((await plan($, { action: 'stop' })).result)).toMatch(/\[-\] 1 a\n\[-\] 2 b/)
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'board' })).toBeUndefined()
  await ui.unmount()
})

test('parallel steps come in as an inner list and are marked in the plan Claude reads', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const set = await plan($, { action: 'set', title: 'P', steps: ['read', ['api', 'ui'], 'test'] })
  expect(String(set.result)).toMatch(/\[ \] 2a api \(parallel with 2b\)/)
  expect(String(set.result)).toMatch(/\[ \] 2b ui \(parallel with 2a\)/)
})

test("Claude's tool changes the plan, and refuses what the locks forbid", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b', 'c'] })
  await plan($, { action: 'done', id: '1' })
  const inserted = await plan($, { action: 'insert', after: '2', text: 'nuovo step' })
  expect(String(inserted.result)).toMatch(/\[ \] 2 b\n\[ \] 4 nuovo step\n\[ \] 3 c/)
  const moved = await plan($, { action: 'move', id: '3', before: '4' })
  expect(String(moved.result)).toMatch(/\[ \] 3 c\n\[ \] 4 nuovo step/)
  const refused = await plan($, { action: 'edit', id: '1', text: 'changed' })
  expect(String(refused.result)).toMatch(/^Not done: Step 1 is done/)
})

test('the band steps aside while a slash command is typed, so the command list shows', async ($, on) => {
  engine(on)
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  // The kit raises prompt.edit at run time; its Engine type does not list it.
  const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit
  const typing = (text: string, inputText: string) => edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })

  await typing('', '/re')
  let ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'board' })).toBeUndefined()
  await ui.unmount()

  await edit({ origin: { kind: 'composer' }, text: '/re', cursor: 3, start: 0, end: 3, inputText: 'hello' })
  ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'board' })).toBeDefined()
  await ui.unmount()
})

test('the band shows only while a plan has open steps, not for work or agents alone', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const idle = { ...BAND, surface: 'vscode' as const, props: { ...BAND.props, isWorking: false } }

  let ui = await $.ui.mount(idle)
  expect(await ui.find({ key: 'board' })).toBeUndefined()
  await ui.unmount()

  // Claude working, with a subagent running, but no plan: no band.
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'look', description: 'Look around', subagentType: 'Explore', parentModel: 'opus', background: false, fork: false } as never)
  ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'board' })).toBeUndefined()
  await ui.unmount()

  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  ui = await $.ui.mount(idle)
  expect(await ui.find({ key: 'board' })).toBeDefined()
  await ui.unmount()

  await plan($, { action: 'done', id: '1' })
  await plan($, { action: 'done', id: '2' })
  ui = await $.ui.mount(idle)
  expect(await ui.find({ key: 'board' })).toBeUndefined()
  await ui.unmount()
})

test('the band is one row: progress, the session totals and the Omniboard button', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'look', description: 'Mappa le route', subagentType: 'Explore', parentModel: 'opus', background: false, fork: false } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▣ 0\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$1\.25 · 1m30s · 150 tok/ })).toBeDefined()
  expect(await ui.find({ key: 'board' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Mappa le route|agent/ })).toBeUndefined()
  await ui.unmount()
})
