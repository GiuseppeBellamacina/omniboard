// The plan as a top-to-bottom graph: one row per step, parallel steps side by side on the same row (forking from
// the row above and joining into the row below), each micro-step on its own row under its step. The browser board
// draws it from live.json.
import type { Plan, Step } from '../types'

export const NODE = { w: 210, h: 46, gapX: 26, gapY: 10, rowGap: 36, pad: 14, indent: 24 }

export type Box = { step: Step; x: number; y: number }
export type Edge = { d: string; done: boolean }
/** Where a "+" (add a micro-step to this step) sits: on the step's rail, just below its last micro-step. */
export type Plus = { id: string; x: number; y: number }
export type Graph = { boxes: Box[]; edges: Edge[]; plus: Plus[]; width: number; height: number }

/** Top-level steps in order, parallel ones sharing a row. */
export function rows(plan: Plan): Step[][] {
  const out: Step[][] = []
  for (const s of plan.steps) {
    if (s.parent) continue
    const last = out.at(-1)
    if (last && s.group && last[0]!.group === s.group) last.push(s)
    else out.push([s])
  }
  return out
}

export function layout(plan: Plan): Graph {
  const { w, h, gapX, gapY, rowGap, pad, indent } = NODE
  const all = rows(plan)
  const cols = Math.max(1, ...all.map(r => r.length))
  const boxes: Box[] = []
  const edges: Edge[] = []
  const plus: Plus[] = []
  const placed: { step: Step; x: number; top: number; bottom: number }[][] = []
  let y = pad
  for (const row of all) {
    const line = row.map((top, c) => {
      const x = pad + c * (w + gapX)
      boxes.push({ step: top, x, y })
      const micro = plan.steps.filter(s => s.parent === top.id)
      micro.forEach((m, k) => {
        const my = y + (k + 1) * (h + gapY)
        boxes.push({ step: m, x: x + indent, y: my })
        edges.push({ d: `M${x + 12} ${y + h}V${my + h / 2}H${x + indent}`, done: m.status === 'done' })
      })
      return { step: top, x, top: y, bottom: y + h + micro.length * (h + gapY) }
    })
    placed.push(line)
    y = Math.max(...line.map(l => l.bottom)) + rowGap
  }
  placed.forEach((line, i) => {
    for (const a of line) plus.push({ id: a.step.id, x: a.x + 12, y: a.bottom + 9 })
    const next = placed[i + 1]
    if (!next) return
    // Fork and join: every step of a row connects to every step of the next row through the gap between them.
    const mid = Math.max(...line.map(l => l.bottom)) + rowGap / 2 + 6
    for (const a of line) for (const b of next) edges.push({ d: `M${a.x + 12} ${a.bottom}V${mid}H${b.x + 12}V${b.top}`, done: a.step.status === 'done' })
  })
  return { boxes, edges, plus, width: pad * 2 + cols * w + (cols - 1) * gapX + indent, height: y - rowGap + pad + 12 }
}
