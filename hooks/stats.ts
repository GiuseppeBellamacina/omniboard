// Session totals, the CSV ledger the board reads, and number formatting. Pure functions.
import type { SessionStats } from '../types'

export const HEADER = 'key,started,project,title,model,cost_usd,agent_minutes,tokens,turns,source'

/** The folder or repository name, whichever separator the platform uses. */
export const projectName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** One row per session start (a /clear starts a new one): the same key the import writes, so nothing counts twice. */
export const keyOf = (sessionId: string, startedAt: number) => `${sessionId.slice(0, 8)}-${startedAt}`

const field = (v: string | number) => {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const rowOf = (s: SessionStats, source = 'live') =>
  [s.key, new Date(s.started).toISOString(), s.project, s.title, s.model, s.cost.toFixed(4), (s.agentMs / 60000).toFixed(2), s.tokens, s.turns, source]
    .map(field)
    .join(',')

/** Replaces the row with the same key, or appends it; keeps every other row as it was. */
export function upsert(csv: string, key: string, row: string): string {
  const lines = csv.split(/\r?\n/).filter(l => l !== '' && l !== HEADER && !l.startsWith(`${key},`))
  return [HEADER, ...lines, row].join('\n') + '\n'
}

/** Totals of a turn's usage: what the API was sent and returned, cache included. */
export const usageTokens = (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) =>
  (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

export const money = (usd: number) => `$${usd.toFixed(2)}`
export const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
