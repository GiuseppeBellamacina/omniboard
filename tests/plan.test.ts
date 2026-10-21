import { expect, test } from 'claude-code/testing'

import { layout, NODE } from '../hooks/graph'
import { add, allowed, applyEdit, find, mark, newPlan } from '../hooks/plan'
import { keyOf, projectName, rowOf, upsert, HEADER } from '../hooks/stats'
import type { Plan } from '../types'

const ok = (out: ReturnType<typeof applyEdit>): Plan => {
  if ('error' in out) throw new Error(out.error)
  return out.plan
}

test('micro-steps of one step each get their own row, none overlapping', async () => {
  let plan = newPlan('P', ['a', 'b', 'c'], 0)
  plan = ok(add(plan, '2', 'm1', true))
  plan = ok(add(plan, '2', 'm2', true))
  plan = ok(add(plan, '2.1', 'm1b', true))
  expect(plan.steps.map(s => s.id)).toEqual(['1', '2', '2.1', '2.3', '2.2', '3'])
  const { boxes } = layout(plan)
  for (const a of boxes) for (const b of boxes) {
    if (a === b) continue
    const apart = a.x + NODE.w <= b.x || b.x + NODE.w <= a.x || a.y + NODE.h <= b.y || b.y + NODE.h <= a.y
    expect(apart).toBe(true)
  }
})

test('parallel steps share a row, fork from the step above and join into the step below', async () => {
  let plan = newPlan('P', ['read', ['api', 'ui', 'docs'], 'test'], 0)
  expect(plan.steps.map(s => `${s.id}:${s.group ?? '-'}`)).toEqual(['1:-', '2a:2', '2b:2', '2c:2', '3:-'])
  plan = ok(add(plan, '2b', 'mock the server', true))
  const { boxes, edges } = layout(plan)
  const at = (id: string) => boxes.find(b => b.step.id === id)!
  expect(new Set(['2a', '2b', '2c'].map(id => at(id).y)).size).toBe(1)
  expect(at('2a').y).toBeGreaterThan(at('1').y)
  expect(at('3').y).toBeGreaterThan(at('2b.1').y)
  // 1 → 2a/2b/2c and 2a/2b/2c → 3, plus the micro-step's elbow.
  expect(edges.length).toBe(3 + 3 + 1)
  for (const a of boxes) for (const b of boxes) {
    if (a === b) continue
    expect(a.x + NODE.w <= b.x || b.x + NODE.w <= a.x || a.y + NODE.h <= b.y || b.y + NODE.h <= a.y).toBe(true)
  }
  expect('error' in applyEdit(plan, { op: 'move', id: '2a', before: '2b' })).toBe(true)
})

test('a done section is locked: no edits, no micro-steps, no moves across it', async () => {
  let plan = newPlan('P', ['a', 'b', 'c', 'd'], 0)
  plan = ok(mark(plan, '1', 'done', 1))
  plan = ok(mark(plan, '2', 'running', 1))
  expect(add(plan, '1', 'late', true)).toEqual({ error: 'Step 1 is done: no micro-steps can be added to it.' })
  expect('error' in applyEdit(plan, { op: 'edit', id: '1', text: 'changed' })).toBe(true)
  expect('error' in applyEdit(plan, { op: 'skip', id: '2' })).toBe(true)
  expect('error' in applyEdit(plan, { op: 'move', id: '4', before: '2' })).toBe(true)
  expect(allowed(plan, find(plan, '1')!)).toEqual({ add: false, edit: false, skip: false, restore: false, remove: false, up: false, down: false })
  // The running step's section stays open to micro-steps; pending steps can still swap.
  plan = ok(add(plan, '2', 'micro', true))
  plan = ok(applyEdit(plan, { op: 'move', id: '4', before: '3' }))
  expect(plan.steps.filter(s => !s.parent).map(s => s.id)).toEqual(['1', '2', '4', '3'])
})

test('Claude cannot close the plan while a step the user added is open', async () => {
  let plan = newPlan('P', ['a', 'b'], 0)
  plan = ok(add(plan, '2', 'yours', true))
  plan = ok(mark(plan, '1', 'done', 1))
  const out = mark(plan, '2', 'done', 2)
  expect('error' in out && out.error).toMatch(/step 2\.1 "yours"/)
  plan = ok(mark(plan, '2.1', 'done', 2))
  expect('error' in mark(plan, '2', 'done', 3)).toBe(false)
})

test('Claude can insert, rename, skip and move its own steps, but not the ones the user added or changed', async () => {
  let plan = newPlan('P', ['read', ['api', 'ui'], 'test'], 0)
  plan = ok(applyEdit(plan, { op: 'insert', after: '2b', text: 'migrate the db' }, 'claude'))
  plan = ok(applyEdit(plan, { op: 'insert', after: null, text: 'release' }, 'claude'))
  expect(plan.steps.map(s => s.id)).toEqual(['1', '2a', '2b', '4', '3', '5'])
  expect(find(plan, '4')!.byUser).toBeUndefined()

  plan = ok(applyEdit(plan, { op: 'edit', id: '3', text: 'run the tests' }, 'claude'))
  expect(find(plan, '3')!.editedByUser).toBeUndefined()
  plan = ok(applyEdit(plan, { op: 'move', id: '5', before: '3' }, 'claude'))
  expect(plan.steps.filter(s => !s.parent).map(s => s.id)).toEqual(['1', '2a', '2b', '4', '5', '3'])

  plan = ok(add(plan, '4', 'yours', true))
  plan = ok(applyEdit(plan, { op: 'edit', id: '1', text: 'read all the code' }))
  for (const edit of [{ op: 'edit', id: '4.1', text: 'x' }, { op: 'skip', id: '4.1' }, { op: 'remove', id: '4.1' }, { op: 'edit', id: '1', text: 'y' }] as const) {
    expect('error' in applyEdit(plan, edit, 'claude')).toBe(true)
  }
  plan = ok(applyEdit(plan, { op: 'skip', id: '5' }, 'claude'))
  expect(find(plan, '5')!.status).toBe('skipped')
})

test('a complete plan is read-only for the person', async () => {
  let plan = newPlan('P', ['a', 'b'], 0)
  plan = ok(applyEdit(plan, { op: 'skip', id: '2' }))
  plan = ok(mark(plan, '1', 'done', 1))
  expect(allowed(plan, find(plan, '2')!)).toEqual({ add: false, edit: false, skip: false, restore: false, remove: false, up: false, down: false })
  expect(applyEdit(plan, { op: 'restore', id: '2' })).toEqual({ error: 'The plan is complete: it can no longer change.' })
})

test('skip and restore take the micro-steps along; remove drops them', async () => {
  let plan = newPlan('P', ['a', 'b'], 0)
  plan = ok(add(plan, '2', 'm', true))
  plan = ok(applyEdit(plan, { op: 'skip', id: '2' }))
  expect(plan.steps.map(s => s.status)).toEqual(['pending', 'skipped', 'skipped'])
  plan = ok(applyEdit(plan, { op: 'restore', id: '2' }))
  expect(plan.steps.map(s => s.status)).toEqual(['pending', 'pending', 'pending'])
  plan = ok(applyEdit(plan, { op: 'remove', id: '2' }))
  expect(plan.steps.map(s => s.id)).toEqual(['1'])
})

test('ledger rows upsert by key; project names work with either separator', async () => {
  expect(projectName('d:\\Codici\\Workspace')).toBe('Workspace')
  expect(projectName('/home/me/repo/')).toBe('repo')
  const s = { key: keyOf('2fdd950f-aaaa', 1000), started: 1000, project: 'Workspace', title: 'Hi, "you"', model: 'opus', cost: 1.5, lastCost: 0, tokens: 10, agentMs: 60000, turns: 2 }
  let csv = upsert('', s.key, rowOf(s))
  csv = upsert(csv, s.key, rowOf({ ...s, turns: 3 }))
  const lines = csv.trim().split('\n')
  expect(lines[0]).toBe(HEADER)
  expect(lines.length).toBe(2)
  expect(lines[1]).toMatch(/^2fdd950f-1000,.*,Workspace,"Hi, ""you""",opus,1\.5000,1\.00,10,3,live$/)
})
