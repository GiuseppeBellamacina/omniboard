// The plan as a top-to-bottom graph: one row per step, parallel steps side by side on the same row (forking from
// the row above and joining into the row below), each micro-step on its own row under its step. One layout feeds
// the pane's SVG and the browser board, which draws it from live.json.
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

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export const MARK: Record<Step['status'], string> = { done: '✓', running: '▶', pending: '○', skipped: '–' }

/** What a node says under its title. */
export function caption(plan: Plan, s: Step): string {
  const state = s.status === 'pending' ? (s.byUser ? 'added by you' : s.editedByUser ? 'edited by you' : 'pending') : s.status
  return s.group ? `parallel · ${state}` : state
}

// Fixed colours: the SVG is drawn as an image, outside the host's theme, so its cards carry their own dark ground.
const INK = { card: '#1a2029', line: '#3a4554', text: '#e3e8ef', muted: '#8a96a5', done: '#62c7a1', run: '#f0b35b', pending: '#5d6876', par: '#c49cf4' }

export function svgSource(plan: Plan): string {
  const g = layout(plan)
  const { w, h } = NODE
  const parts: string[] = g.edges.map(e => `<path d="${e.d}" stroke="${e.done ? INK.done : INK.line}" stroke-width="1.5" fill="none"/>`)
  for (const { step: s, x, y } of g.boxes) {
    const bar = s.status === 'done' ? INK.done : s.status === 'running' ? INK.run : INK.pending
    const title = s.status === 'pending' || s.status === 'running' ? INK.text : INK.muted
    parts.push(
      `<g><title>${esc(`${s.id} ${s.text}`)}</title>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${INK.card}" stroke="${s.status === 'running' ? INK.run : s.group ? INK.par : INK.line}"/>` +
        `<rect x="${x}" y="${y + 9}" width="3" height="${h - 18}" rx="1.5" fill="${bar}"/>` +
        `<text x="${x + 13}" y="${y + 19}" fill="${title}" font-family="system-ui, sans-serif" font-size="13"${s.status === 'skipped' ? ' text-decoration="line-through"' : ''}>${esc(`${MARK[s.status]} ${s.id}  ${cut(s.text, 26)}`)}</text>` +
        `<text x="${x + 13}" y="${y + 36}" fill="${s.group ? INK.par : INK.muted}" font-family="system-ui, sans-serif" font-size="11">${esc(caption(plan, s))}</text></g>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}">${parts.join('')}</svg>`
}

/** The terminal's version: one line per row of the graph, parallel steps side by side. */
export function textChain(plan: Plan): string {
  return rows(plan)
    .map(row => row.map(s => `${MARK[s.status]} ${s.id}`).join(row.length > 1 ? '  ∥  ' : ''))
    .join('\n  │\n')
}
