// The plan as a graph: top-level steps left to right, each micro-step on its own row under its step.
import type { Plan, Step } from '../types'

export const NODE = { w: 168, h: 52, gapX: 40, gapY: 14, pad: 16 }

export type Box = { step: Step; x: number; y: number }

export function layout(plan: Plan): { boxes: Box[]; width: number; height: number } {
  const { w, h, gapX, gapY, pad } = NODE
  const tops = plan.steps.filter(s => !s.parent)
  const boxes: Box[] = []
  let deepest = 0
  tops.forEach((top, i) => {
    const x = pad + i * (w + gapX)
    boxes.push({ step: top, x, y: pad })
    const micro = plan.steps.filter(s => s.parent === top.id)
    micro.forEach((m, k) => boxes.push({ step: m, x: x + 22, y: pad + (k + 1) * (h + gapY) }))
    deepest = Math.max(deepest, micro.length)
  })
  return {
    boxes,
    width: pad * 2 + Math.max(1, tops.length) * w + Math.max(0, tops.length - 1) * gapX + 22,
    height: pad * 2 + h + deepest * (h + gapY),
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Fixed colours: the SVG is drawn as an image, outside the host's theme, so its cards carry their own dark ground.
const INK = { card: '#1a2029', line: '#3a4554', text: '#e3e8ef', muted: '#8a96a5', done: '#62c7a1', run: '#f0b35b', pending: '#5d6876' }
const MARK: Record<Step['status'], string> = { done: '✓', running: '▶', pending: '○', skipped: '–' }

export function svgSource(plan: Plan): string {
  const { boxes, width, height } = layout(plan)
  const { w, h } = NODE
  const at = new Map(boxes.map(b => [b.step.id, b]))
  const parts: string[] = []
  const tops = boxes.filter(b => !b.step.parent)
  tops.forEach((b, i) => {
    const next = tops[i + 1]
    if (next) parts.push(`<path d="M${b.x + w} ${b.y + h / 2}H${next.x}" stroke="${b.step.status === 'done' ? INK.done : INK.line}" stroke-width="1.5" fill="none"/>`)
  })
  for (const b of boxes) {
    if (!b.step.parent) continue
    const p = at.get(b.step.parent)!
    parts.push(`<path d="M${p.x + 11} ${p.y + h}V${b.y + h / 2}H${b.x}" stroke="${INK.line}" stroke-width="1.5" fill="none"/>`)
  }
  for (const b of boxes) {
    const s = b.step
    const bar = s.status === 'done' ? INK.done : s.status === 'running' ? INK.run : INK.pending
    const sub = s.status === 'running' ? 'running' : s.status === 'done' ? 'done' : s.status === 'skipped' ? 'skipped' : s.byUser ? 'added by you' : 'pending'
    parts.push(
      `<g><title>${esc(`${s.id} ${s.text}`)}</title>` +
        `<rect x="${b.x}" y="${b.y}" width="${w}" height="${h}" rx="8" fill="${INK.card}" stroke="${s.status === 'running' ? INK.run : INK.line}"/>` +
        `<rect x="${b.x}" y="${b.y + 10}" width="3" height="${h - 20}" rx="1.5" fill="${bar}"/>` +
        `<text x="${b.x + 13}" y="${b.y + 22}" fill="${s.status === 'pending' || s.status === 'running' ? INK.text : INK.muted}" font-family="system-ui, sans-serif" font-size="13"${s.status === 'skipped' ? ' text-decoration="line-through"' : ''}>${esc(`${MARK[s.status]} ${s.id}  ${cut(s.text, 17)}`)}</text>` +
        `<text x="${b.x + 13}" y="${b.y + 39}" fill="${INK.muted}" font-family="system-ui, sans-serif" font-size="11">${sub}</text></g>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

/** The terminal's version: the top-level chain on one line. */
export function textChain(plan: Plan): string {
  return plan.steps
    .filter(s => !s.parent)
    .map(s => `(${s.status === 'done' ? '✓' : s.status === 'running' ? '▶' : s.status === 'skipped' ? '–' : ' '})`)
    .join('──')
}

export { MARK }
