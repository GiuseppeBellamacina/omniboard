// The plan and every change to it: pure functions, the one place the pane, the board server and Claude's tool apply edits.
import type { Plan, Step } from '../types'

export type Edit =
  | { op: 'add'; after: string; text: string }
  | { op: 'edit'; id: string; text: string }
  | { op: 'skip'; id: string }
  | { op: 'restore'; id: string }
  | { op: 'remove'; id: string }
  /** `before` null: to the end of the step's level. */
  | { op: 'move'; id: string; before: string | null }

export type Outcome = { plan: Plan; note: string } | { error: string }

const clean = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200)
const quote = (text: string) => `"${text}"`

/** A step is a string; a list of strings is a set of steps that run in parallel ("2a", "2b", ... in group "2"). */
export type StepInput = string | readonly string[]

export function newPlan(title: string, items: readonly StepInput[], now: number): Plan {
  const steps: Step[] = []
  let n = 0
  for (const item of items) {
    const texts = (typeof item === 'string' ? [item] : item).map(t => clean(String(t))).filter(Boolean)
    if (texts.length === 0) continue
    n += 1
    if (texts.length === 1) steps.push({ id: String(n), text: texts[0]!, status: 'pending' })
    else texts.forEach((text, i) => steps.push({ id: `${n}${String.fromCharCode(97 + (i % 26))}`, text, status: 'pending', group: String(n) }))
  }
  return { title: clean(title) || 'Plan', startedAt: now, steps }
}

/** The other branches running in parallel with a step. */
export const parallelTo = (plan: Plan, step: Step) => (step.group ? plan.steps.filter(s => s.group === step.group && s !== step) : [])

export const find = (plan: Plan, id: string) => plan.steps.find(s => s.id === id)
/** The top-level step a step belongs to: itself, or its parent. */
export const section = (plan: Plan, step: Step) => (step.parent ? find(plan, step.parent) : step)
/** A section Claude finished is closed to edits. */
export const isLocked = (plan: Plan, step: Step) => section(plan, step)?.status === 'done'
const children = (plan: Plan, id: string) => plan.steps.filter(s => s.parent === id)
const siblings = (plan: Plan, step: Step) => plan.steps.filter(s => s.parent === step.parent)

export function progress(plan: Plan) {
  const counted = plan.steps.filter(s => s.status !== 'skipped')
  return { done: counted.filter(s => s.status === 'done').length, total: counted.length }
}

/** What the person may do to a step right now; the pane and the board show only these. */
export function allowed(plan: Plan, step: Step) {
  const open = !isLocked(plan, step)
  const pending = open && step.status === 'pending'
  const level = siblings(plan, step)
  const i = level.indexOf(step)
  // shortcut: parallel branches do not move (a move would split their group); reorder by editing the group's steps instead.
  const movable = (j: number) => pending && !step.group && !level[j]?.group && level[j]?.status === 'pending' && !hasChildrenStarted(plan, level[j]!)
  return {
    add: open && step.status !== 'skipped',
    edit: open,
    skip: pending && !hasChildrenStarted(plan, step),
    restore: open && step.status === 'skipped',
    remove: pending && !hasChildrenStarted(plan, step),
    up: movable(i - 1) && !hasChildrenStarted(plan, step),
    down: movable(i + 1) && !hasChildrenStarted(plan, step),
  }
}

const hasChildrenStarted = (plan: Plan, step: Step) => children(plan, step.id).some(c => c.status !== 'pending')

function nextChildId(plan: Plan, parent: string) {
  const used = children(plan, parent).map(c => Number(c.id.split('.').pop()))
  return `${parent}.${Math.max(0, ...used) + 1}`
}

// Puts `block` (a step and, for a top-level step, its micro-steps) before `before`, or at the end of its level.
function placeBlock(steps: Step[], block: Step[], before: Step | undefined, parent: string | undefined): Step[] {
  const rest = steps.filter(s => !block.includes(s))
  let at: number
  if (before) at = rest.indexOf(before)
  else if (parent) {
    const last = rest.map(s => s.parent === parent || s.id === parent).lastIndexOf(true)
    at = last + 1
  } else at = rest.length
  return [...rest.slice(0, at), ...block, ...rest.slice(at)]
}

/** A change the person made, from the pane or the board. */
export function applyEdit(plan: Plan, edit: Edit): Outcome {
  if (edit.op === 'add') return add(plan, edit.after, edit.text, true)
  const step = find(plan, edit.id)
  if (!step) return { error: `Step ${edit.id} no longer exists.` }
  if (isLocked(plan, step)) return { error: `Step ${section(plan, step)!.id} is done: its section can no longer change.` }
  const can = allowed(plan, step)
  const swap = (fields: Partial<Step>) => plan.steps.map(s => (s === step ? { ...s, ...fields } : s))

  switch (edit.op) {
    case 'edit': {
      const text = clean(edit.text)
      if (!text) return { error: 'A step needs some text.' }
      if (text === step.text) return { error: 'Nothing changed.' }
      return { plan: { ...plan, steps: swap({ text, editedByUser: !step.byUser }) }, note: `renamed step ${step.id} to ${quote(text)}` }
    }
    case 'skip': {
      if (!can.skip) return { error: `Step ${step.id} has already started.` }
      const ids = new Set([step.id, ...children(plan, step.id).map(c => c.id)])
      return {
        plan: { ...plan, steps: plan.steps.map(s => (ids.has(s.id) ? { ...s, status: 'skipped' as const } : s)) },
        note: `skipped step ${step.id} (${quote(step.text)})`,
      }
    }
    case 'restore': {
      if (!can.restore) return { error: `Step ${step.id} is not skipped.` }
      const ids = new Set([step.id, ...children(plan, step.id).map(c => c.id)])
      return {
        plan: { ...plan, steps: plan.steps.map(s => (ids.has(s.id) && s.status === 'skipped' ? { ...s, status: 'pending' as const } : s)) },
        note: `brought back step ${step.id} (${quote(step.text)})`,
      }
    }
    case 'remove': {
      if (!can.remove) return { error: `Step ${step.id} has already started.` }
      const gone = new Set([step.id, ...children(plan, step.id).map(c => c.id)])
      return { plan: { ...plan, steps: plan.steps.filter(s => !gone.has(s.id)) }, note: `removed step ${step.id} (${quote(step.text)})` }
    }
    case 'move': {
      if (step.status !== 'pending' || hasChildrenStarted(plan, step)) return { error: `Step ${step.id} has already started.` }
      const target = edit.before === null ? undefined : find(plan, edit.before)
      if (edit.before !== null && !target) return { error: `Step ${edit.before} no longer exists.` }
      if (target === step) return { error: 'Nothing changed.' }
      if (target && target.parent !== step.parent) return { error: 'A step can move only among the steps of its own level.' }
      if (step.group || target?.group) return { error: 'Parallel steps stay together: they cannot be moved one by one.' }
      // Never across work that has started: every step between the old and the new place must still be pending.
      const level = siblings(plan, step)
      const from = level.indexOf(step)
      const to = target ? level.indexOf(target) : level.length
      const between = from < to ? level.slice(from + 1, to) : level.slice(to, from)
      if (between.some(s => s.status !== 'pending' || hasChildrenStarted(plan, s))) return { error: 'A step cannot move past work that has started.' }
      if (target && isLocked(plan, target)) return { error: `Step ${target.id} is done: its section can no longer change.` }
      const block = [step, ...children(plan, step.id)]
      const steps = placeBlock(plan.steps, block, target, step.parent)
      const where = target ? `before step ${target.id}` : 'to the end'
      return { plan: { ...plan, steps }, note: `moved step ${step.id} (${quote(step.text)}) ${where}` }
    }
  }
}

/** Adds a micro-step to the section of `after`, right after it. */
export function add(plan: Plan, after: string, text: string, byUser: boolean): Outcome {
  const anchor = find(plan, after)
  if (!anchor) return { error: `Step ${after} no longer exists.` }
  const top = section(plan, anchor)!
  if (top.status === 'done') return { error: `Step ${top.id} is done: no micro-steps can be added to it.` }
  if (top.status === 'skipped') return { error: `Step ${top.id} is skipped: bring it back first.` }
  const body = clean(text)
  if (!body) return { error: 'A step needs some text.' }
  const step: Step = { id: nextChildId(plan, top.id), text: body, status: 'pending', parent: top.id, ...(byUser ? { byUser } : {}) }
  // After the step itself when it is a micro-step; after the section's last micro-step when it is the top step.
  const last = anchor.parent ? anchor : children(plan, top.id).at(-1) ?? top
  const at = plan.steps.indexOf(last) + 1
  return {
    plan: { ...plan, steps: [...plan.steps.slice(0, at), step, ...plan.steps.slice(at)] },
    note: `added step ${step.id} ${quote(body)} to step ${top.id}`,
  }
}

/** Claude's own progress. A step can be marked done only while no step the person added is left behind. */
export function mark(plan: Plan, id: string, status: 'running' | 'done', now: number): Outcome {
  const step = find(plan, id)
  if (!step) return { error: `There is no step ${id}. The steps are: ${plan.steps.map(s => s.id).join(', ')}.` }
  const fields: Partial<Step> = status === 'running' ? { status, startedAt: step.startedAt ?? now } : { status, endedAt: now }
  const next = { ...plan, steps: plan.steps.map(s => (s === step ? { ...s, ...fields } : s)) }
  if (status === 'done') {
    const yours = next.steps.filter(s => s.status !== 'done' && s.status !== 'skipped' && (s.byUser || s.editedByUser))
    const rest = next.steps.filter(s => s.status !== 'done' && s.status !== 'skipped' && !s.byUser && !s.editedByUser)
    if (rest.length === 0 && yours.length > 0) {
      return { error: `Not marked: the user added or changed ${yours.map(s => `step ${s.id} ${quote(s.text)}`).join(', ')}. Do ${yours.length > 1 ? 'them' : 'it'} first, or ask the user.` }
    }
  }
  return { plan: next, note: '' }
}

const GLYPH: Record<Step['status'], string> = { pending: '[ ]', running: '[>]', done: '[x]', skipped: '[-]' }

/** The plan as Claude reads it in a tool result or a note. */
export function describe(plan: Plan): string {
  const { done, total } = progress(plan)
  const lines = plan.steps.map(s => {
    const others = parallelTo(plan, s).map(o => o.id)
    const tags = [others.length ? `parallel with ${others.join(', ')}` : '', s.byUser ? 'added by the user' : '', s.editedByUser ? 'changed by the user' : ''].filter(Boolean)
    return `${s.parent ? '    ' : ''}${GLYPH[s.status]} ${s.id} ${s.text}${tags.length ? ` (${tags.join(', ')})` : ''}`
  })
  return [`Plan: ${plan.title} (${done}/${total} done)`, ...lines].join('\n')
}

/** The note Claude reads after the person changed the plan. */
export const noteFor = (notes: readonly string[], plan: Plan | null) =>
  `The user changed your plan in omniboard: ${notes.join('; ')}. Read the updated plan and follow it before going on; ` +
  `keep it current with mcp__omniboard__plan.\n\n${plan ? describe(plan) : '(no plan)'}`
