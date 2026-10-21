#!/usr/bin/env node
// Adds past Claude Code sessions to the omniboard ledger: one row per session, from the transcripts in
// ~/.claude/projects (Claude Code's own cost-state records give cost, tokens and timing), plus any rows
// ponytail's band ledger kept. Sessions already in the ledger are left alone. Node standard library only.
//   node import.mjs --dir <omniboard data folder> [--skip <session id prefix>] [--projects <folder>] [--ponytail <folder>]
//   node import.mjs --self-test
import { createReadStream } from 'node:fs'
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const HEADER = 'key,started,project,title,model,cost_usd,agent_minutes,tokens,turns,source'
const field = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const projectName = p => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'other'

function parseCsv(text) {
  const rows = []
  let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x !== '')) rows.push(row); row = [] }
    else f += c
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  return rows
}

/** One transcript → one ledger row, or null when it holds no prompt of the person's. */
async function sessionOf(file) {
  let cost = null, cwd = '', title = '', firstPrompt = '', turns = 0, id = basename(file, '.jsonl'), outTokens = 0
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.includes('"type":"cost-state"')) { try { cost = JSON.parse(line) } catch {} continue }
    if (line.includes('"type":"ai-title"')) { try { title = JSON.parse(line).aiTitle || title } catch {} continue }
    if (line.includes('"type":"custom-title"')) { try { title = JSON.parse(line).customTitle || title } catch {} continue }
    if (!cwd) { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line); if (m) try { cwd = JSON.parse(`"${m[1]}"`) } catch {} }
    if (line.startsWith('{"parentUuid"') && line.includes('"type":"user"') && !line.includes('"toolUseResult"') && !line.includes('"isMeta":true') && line.length < 400_000) {
      try {
        const rec = JSON.parse(line)
        const c = rec.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : ''
        // A prompt the person typed: text, no tool result, not one of the engine's own <tags>.
        const typed = text && !text.startsWith('<') && !(Array.isArray(c) && c.some(b => b.type === 'tool_result'))
        if (typed) {
          turns++
          if (!firstPrompt) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 80)
        }
      } catch {}
    } else if (!cost && line.includes('"type":"assistant"') && line.includes('"output_tokens"')) {
      const m = /"output_tokens":(\d+)/.exec(line); if (m) outTokens += Number(m[1])
    }
  }
  if (turns === 0) return null
  const usage = Object.entries(cost?.modelUsage ?? {})
  const tokens = cost ? usage.reduce((a, [, u]) => a + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0), 0) : outTokens
  const model = usage.sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0))[0]?.[0] ?? ''
  const started = cost?.startTime ?? null
  if (!started) return null
  return {
    key: `${id.slice(0, 8)}-${started}`,
    started: new Date(started).toISOString(),
    project: projectName(cwd),
    title: title || firstPrompt || '(untitled)',
    model,
    cost: cost ? Number(cost.totalCostUSD || 0).toFixed(4) : '',
    agent_minutes: cost ? (((cost.totalAPIDuration || 0) + (cost.totalToolDuration || 0)) / 60000).toFixed(2) : '',
    tokens,
    turns,
    source: 'import',
  }
}

async function transcripts(root) {
  const out = []
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue
    for (const f of await readdir(join(root, dir.name), { withFileTypes: true }).catch(() => [])) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(root, dir.name, f.name))
    }
  }
  return out
}

async function ponytailRows(folder) {
  const rows = []
  for (const f of await readdir(folder).catch(() => [])) {
    if (!f.endsWith('.csv')) continue
    const [head, ...data] = parseCsv(await readFile(join(folder, f), 'utf8'))
    if (!head) continue
    for (const r of data) {
      const o = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))
      const started = Date.parse(o.started?.replace(' ', 'T'))
      if (!o.key || isNaN(started)) continue
      rows.push({ key: o.key, started: new Date(started).toISOString(), project: projectName(o.project), title: o.name || '(untitled)', model: o.model, cost: o.cost_usd, agent_minutes: o.agent_minutes, tokens: o.tokens_total, turns: o.turns, source: 'ponytail' })
    }
  }
  return rows
}

async function run({ dir, skip = '', projects, ponytail }) {
  const ledger = join(dir, 'sessions.csv')
  const csv = await readFile(ledger, 'utf8').catch(() => '')
  const known = new Set(parseCsv(csv).slice(1).map(r => (r[0] || '').slice(0, 8)))
  if (skip) known.add(skip.slice(0, 8))
  const found = []
  for (const file of await transcripts(projects)) {
    const id = basename(file).slice(0, 8)
    if (known.has(id)) continue
    const row = await sessionOf(file).catch(() => null)
    if (row) { found.push(row); known.add(id) }
  }
  const fromPonytail = (await ponytailRows(ponytail)).filter(r => !known.has(r.key.slice(0, 8)))
  const rows = [...found, ...fromPonytail]
  if (rows.length) {
    await mkdir(dir, { recursive: true })
    const lines = csv.split(/\r?\n/).filter(l => l && l !== HEADER)
    const added = rows.map(r => [r.key, r.started, r.project, r.title, r.model, r.cost, r.agent_minutes, r.tokens, r.turns, r.source].map(field).join(','))
    await writeFile(ledger, [HEADER, ...lines, ...added].join('\n') + '\n')
  }
  return { transcripts: found.length, ponytail: fromPonytail.length }
}

async function selfTest() {
  const assert = (c, what) => { if (!c) throw new Error(`self-test failed: ${what}`) }
  const root = await mkdtemp(join(tmpdir(), 'omniboard-import-'))
  try {
    const proj = join(root, 'projects', 'd--Codici-Workspace')
    await mkdir(proj, { recursive: true })
    const rec = o => JSON.stringify(o)
    await writeFile(join(proj, 'aaaaaaaa-1111.jsonl'), [
      rec({ parentUuid: null, type: 'user', cwd: 'd:\\Codici\\Workspace', message: { role: 'user', content: 'Rifai la pipeline' } }),
      rec({ parentUuid: 'x', type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      rec({ parentUuid: 'y', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'and the tests' }] } }),
      rec({ type: 'ai-title', aiTitle: 'Pipeline, "v2"' }),
      rec({ type: 'cost-state', totalCostUSD: 1.5, totalAPIDuration: 60000, totalToolDuration: 30000, startTime: 1790000000000,
        modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 70, costUSD: 1.4 }, 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } } }),
    ].join('\n'))
    await writeFile(join(proj, 'bbbbbbbb-2222.jsonl'), rec({ parentUuid: null, type: 'user', message: { role: 'user', content: 'skipped: current session' } }))
    const pony = join(root, 'ponytail'); await mkdir(pony)
    await writeFile(join(pony, 'x.csv'), 'key,started,project,name,cost_usd,turns,agent_minutes,tokens_total,tokens_output,reuse_pct,reused,new,callers_open,tests,level,model\ncccccccc-5,2026-10-01 10:00,d:\\Codici\\thesis,Grafici,2.00,4,12.0,1000,10,,,,,,import,\n')
    const dir = join(root, 'out')
    const first = await run({ dir, skip: 'bbbbbbbb', projects: join(root, 'projects'), ponytail: pony })
    assert(first.transcripts === 1 && first.ponytail === 1, `counts ${JSON.stringify(first)}`)
    const rows = parseCsv(await readFile(join(dir, 'sessions.csv'), 'utf8'))
    assert(rows[0].join(',') === HEADER, 'header')
    const a = rows.find(r => r[0] === 'aaaaaaaa-1790000000000')
    assert(a && a[2] === 'Workspace' && a[3] === 'Pipeline, "v2"' && a[4] === 'claude-opus-5-5' && a[5] === '1.5000' && a[6] === '1.50' && a[7] === '402' && a[8] === '2', `row ${a}`)
    assert(rows.some(r => r[0] === 'cccccccc-5' && r[2] === 'thesis' && r[9] === 'ponytail'), 'ponytail row')
    const again = await run({ dir, skip: 'bbbbbbbb', projects: join(root, 'projects'), ponytail: pony })
    assert(again.transcripts === 0 && again.ponytail === 0, 'second run adds nothing')
    console.log('self-test ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
if (process.argv.includes('--self-test')) {
  selfTest().catch(err => { console.error(err.message); process.exit(1) })
} else {
  const dir = arg('--dir')
  if (!dir) { console.error('usage: import.mjs --dir <omniboard data folder> [--skip <session id prefix>]'); process.exit(2) }
  const home = homedir()
  run({
    dir,
    skip: arg('--skip') ?? '',
    projects: arg('--projects') ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
    ponytail: arg('--ponytail') ?? join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'ponytail', 'band'),
  }).then(
    r => console.log(`omniboard: added ${r.transcripts} past session(s) from Claude Code's transcripts and ${r.ponytail} from ponytail's ledger. Open /board to see them.`),
    err => { console.error(err.message); process.exit(1) },
  )
}
