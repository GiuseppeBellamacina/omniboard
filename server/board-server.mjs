#!/usr/bin/env node
// Serves the omniboard page on 127.0.0.1 for one session, and hands each plan edit the page sends to the plugin
// as one line on stdout ("EDIT {json}"); the plugin validates and applies it. Node standard library only.
//   node board-server.mjs --dir <data folder> --page <index.html>
//   node board-server.mjs --self-test
import { createServer } from 'node:http'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IDLE_MS = 30 * 60 * 1000
const MAX_BODY = 8 * 1024
const OPS = new Set(['add', 'edit', 'skip', 'restore', 'remove', 'move', 'stop'])

/** RFC 4180 rows: quoted fields may hold commas, quotes and newlines. */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function sessionsFrom(csv) {
  const [head, ...rows] = parseCsv(csv)
  if (!head) return []
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

function start({ dir, page, log = line => process.stdout.write(line + '\n'), idleMs = IDLE_MS }) {
  const token = randomBytes(18).toString('base64url')
  let idle
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => server.close(() => process.exit(0)), idleMs); idle.unref?.() }

  const server = createServer(async (req, res) => {
    const port = server.address().port
    const origin = `http://127.0.0.1:${port}`
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      res.end(body)
    }
    // Another site in the browser, or a DNS-rebinding name, never gets in: exact host, secret path, same origin for writes.
    if (req.headers.host !== `127.0.0.1:${port}`) return send(403, '{"error":"host"}')
    const url = new URL(req.url ?? '/', origin)
    const prefix = `/${token}/`
    if (!url.pathname.startsWith(prefix)) return send(404, '{"error":"not found"}')
    const route = url.pathname.slice(prefix.length)
    // A page with no plan to follow polls with ?idle=1: those polls do not keep the server awake.
    if (url.searchParams.get('idle') !== '1') touch()
    try {
      if (req.method === 'GET' && route === '') {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        return send(200, await readFile(page, 'utf8'), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && route === 'api/live') return send(200, await readFile(join(dir, 'live.json'), 'utf8').catch(() => '{}'))
      if (req.method === 'GET' && route === 'api/stats') {
        const csv = await readFile(join(dir, 'sessions.csv'), 'utf8').catch(() => '')
        return send(200, JSON.stringify(sessionsFrom(csv)))
      }
      if (req.method === 'POST' && route === 'api/edit') {
        if (req.headers.origin !== origin) return send(403, '{"error":"origin"}')
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) return send(413, '{"error":"too large"}')
        }
        let edit
        try { edit = JSON.parse(body) } catch { return send(400, '{"error":"not json"}') }
        if (!edit || typeof edit !== 'object' || !OPS.has(edit.op)) return send(400, '{"error":"unknown edit"}')
        log(`EDIT ${JSON.stringify(edit)}`)
        return send(202, '{"ok":true}')
      }
      return send(404, '{"error":"not found"}')
    } catch (err) {
      return send(500, JSON.stringify({ error: String(err?.message ?? err) }))
    }
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}/`
      log(`READY ${url}`)
      touch()
      resolve({ server, url })
    })
  })
}

async function selfTest() {
  const assert = (cond, what) => { if (!cond) throw new Error(`self-test failed: ${what}`) }
  const dir = await mkdtemp(join(tmpdir(), 'omniboard-'))
  try {
    await writeFile(join(dir, 'live.json'), '{"plan":null}')
    await writeFile(join(dir, 'sessions.csv'), 'key,title,cost_usd\na-1,"Hi, ""you""",1.5\n')
    await writeFile(join(dir, 'page.html'), '<title>Omniboard</title>')
    const lines = []
    const { server, url } = await start({ dir, page: join(dir, 'page.html'), log: l => lines.push(l), idleMs: 60_000 })
    const origin = new URL(url).origin
    assert((await (await fetch(url)).text()).includes('Omniboard'), 'page')
    assert((await fetch(url.replace(/\/[^/]+\/$/, '/wrong/'))).status === 404, 'token required')
    assert((await (await fetch(url + 'api/live')).json()).plan === null, 'live')
    const stats = await (await fetch(url + 'api/stats')).json()
    assert(stats[0].title === 'Hi, "you"' && stats[0].cost_usd === '1.5', 'stats csv')
    const post = (body, headers = { Origin: origin }) => fetch(url + 'api/edit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
    assert((await post('{"op":"skip","id":"2"}', { Origin: 'https://evil.example' })).status === 403, 'foreign origin refused')
    assert((await post('{"op":"rm -rf"}')).status === 400, 'unknown op refused')
    assert((await post('{"op":"skip","id":"2"}')).status === 202, 'edit accepted')
    assert(lines.includes('EDIT {"op":"skip","id":"2"}'), 'edit printed')
    assert((await post('{"op":"stop"}')).status === 202, 'stop accepted')
    server.close()
    console.log('self-test ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
if (process.argv.includes('--self-test')) {
  selfTest().catch(err => { console.error(err.message); process.exit(1) })
} else {
  const dir = arg('--dir'), page = arg('--page')
  if (!dir || !page) { console.error('usage: board-server.mjs --dir <data folder> --page <index.html>'); process.exit(2) }
  start({ dir, page })
}
