# Contributing

## Layout

- `hooks/register.tsx`: the hooks module (events, the `plan` tool, the band, the board server's lifecycle).
- `hooks/plan.ts`: every change to a plan, as pure functions; the board server and Claude's tool both go through it.
- `hooks/graph.ts`: the plan's layout and its SVG; `hooks/stats.ts`: the ledger and number formatting.
- `board/index.html`: the browser board, one self-contained page (no libraries, no external requests).
- `server/board-server.mjs`, `scripts/import.mjs`: Node scripts, standard library only.

## Ground rules

- A done section stays locked; every edit is validated in `plan.ts`, whoever sends it.
- An edit of the user's reaches Claude exactly once, on its next action or prompt.
- Nothing leaves the machine; the server listens on 127.0.0.1 only and never runs what a page sends.
- Keep it light: no timers unless something runs, the board polls only while visible.

## Develop

```bash
git clone https://github.com/GiuseppeBellamacina/omniboard
claude plugin validate ./omniboard
claude plugin test ./omniboard
node omniboard/server/board-server.mjs --self-test
node omniboard/scripts/import.mjs --self-test
claude --plugin-dir ./omniboard       # try it in a session
```

## Pull requests

- One topic per PR, with a test for the behaviour it changes.
- Run the checks above before opening it, and update `README.md` when behaviour changes.
