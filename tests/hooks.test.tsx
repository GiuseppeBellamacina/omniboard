import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__omniboard__plan'
const BAND = {
  plugin: 'omniboard',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const PANE = {
  plugin: 'omniboard',
  component: 'Pane',
  requestId: 'omniboard-plan',
  props: { title: 'Plan', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine beneath the plugin.
function engine(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/test', OS: 'Windows_NT' })
  const files: Record<string, string> = {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__omniboard__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { startedAt: 500_000, cost: { usd: 1.25 }, context: { window: 200000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: '2fdd950f-1234' }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: 'd:\\Codici\\Workspace' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : Promise.reject(new Error('missing'))))
  on('fs.write', (_, e) => ((files[e.path] = e.text), { value: undefined }))
  return { files }
}

const plan = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result?: unknown; context?: readonly string[] }>

test("Claude's plan tool is allowed without asking and drives the checklist", async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /▣ 1\/3 Testare/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an edit made in the pane reaches Claude exactly once, on its next action', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  await plan($, { action: 'start', id: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add-1' })
  await ui.input({ key: 'field-1-add', text: 'Lanciare il lint' })
  await ui.unmount()

  const first = await $.tool.call({ tool: 'Read', file_path: 'x.ts' })
  expect(first.context?.join('\n')).toMatch(/added step 1\.1 "Lanciare il lint" to step 1/)
  expect(first.context?.join('\n')).toMatch(/\[ \] 1\.1 Lanciare il lint \(added by the user\)/)
  const second = await $.tool.call({ tool: 'Read', file_path: 'y.ts' })
  expect(second.context).toBeUndefined()
})

test('a done section shows no edit controls in the pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await plan($, { action: 'set', title: 'P', steps: ['a', 'b'] })
  await plan($, { action: 'done', id: '1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'add-1' })).toBeUndefined()
  expect(await ui.find({ key: 'edit-1' })).toBeUndefined()
  expect(await ui.find({ key: 'add-2' })).toBeDefined()
  await ui.unmount()
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
  // The kit raises prompt.edit at run time; its Engine type does not list it.
  const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit
  const typing = (text: string, inputText: string) => edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })

  await typing('', '/re')
  let ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /omniboard/ })).toBeUndefined()
  await ui.unmount()

  await edit({ origin: { kind: 'composer' }, text: '/re', cursor: 3, start: 0, end: 3, inputText: 'hello' })
  ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /omniboard/ })).toBeDefined()
  await ui.unmount()
})

test('subagents and the session totals show in the expanded band', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'look', description: 'Mappa le route', subagentType: 'Explore', parentModel: 'opus', background: false, fork: false } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 90_000, isAborted: false, turnId: 't1', reason: 'answer', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /Mappa le route/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$1\.25 · 1m30s · 150 tok/ })).toBeDefined()
  await ui.unmount()
})
