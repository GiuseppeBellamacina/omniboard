# omniboard — see where Claude is in its plan, and steer it

> A live checklist of the plan Claude is carrying out, which you can edit while it works (add micro-steps, rename, skip, reorder); its subagents and background tasks at a glance; and your session statistics in a local board.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)

Once you approve a plan, Claude goes off and works. You see tool calls scroll by, but not which step it is on, what is left, or what the three subagents it started are doing. `omniboard` puts that in one place, and lets you change the plan without stopping Claude.

## Install

```text
/plugin marketplace add GiuseppeBellamacina/cosmic-plugins
/plugin install omniboard@cosmic-plugins
```

Where `/plugin` isn't available (e.g. the VS Code extension), run these in a terminal, then `/reload-plugins` in the session:

```bash
claude plugin marketplace add GiuseppeBellamacina/cosmic-plugins
claude plugin install omniboard@cosmic-plugins
```

Requires a Claude Code build with plugin function hooks (mods) and [Node.js](https://nodejs.org) 18+ for the browser board and the import (standard library only, nothing to `npm install`).

## What you get

### A band above the prompt

One row, while a plan has open steps (one you approved, or steps Claude set for a longer task): the plan's progress and current step, the subagents and background tasks running meanwhile, and the session's cost, agent time and tokens. **▾** expands it (the choice is remembered), **Board** opens the browser board, **Plan** the checklist. With no plan running it does not show, and it steps aside while you type a slash command.

```text
▣ 3/7 ■■■□□□□□  │  ● 2 agents · ⧗ 1 bg  │  $4.21 · 12m04s · 1.2M tok     Board  Plan  ▾
```

The band keeps to the count and the progress bar; the steps themselves are in the checklist and the board.

Expanded, it adds the plan's title, the running and latest subagents (type, task, time, tokens, the tool they are using) and the background tasks.

### `/checklist`: the plan you can edit

A pane inside Claude Code: the plan as a graph read top to bottom (drawn as SVG in VS Code and the desktop app, as text in the terminal) and as a list where each step offers what you may do to it now. Steps that run in parallel sit side by side on one row, forking from the step above and joining into the step below, and are marked *parallel*.

- **+ after**: add a micro-step to that step; several micro-steps of one step each get their own row;
- **edit**: rename a step; **skip** / **restore**; **↑ ↓**: reorder pending steps; **✕**: remove a step you added.

### `/board`: the browser board

A local page with two tabs, in a light and a dark theme (it follows your system; the button in the top bar switches it).

- **Live**: the plan as an outline. Click a step and it opens in place: rename it (Enter saves, Esc closes), add a micro-step, skip, restore, remove a step you added, move it (or Alt+↑ / Alt+↓, or drag its handle). A refused edit says why under the step it touched. Parallel steps sit in one block; finished steps carry a lock. **Graph** in the top bar shows the same plan as a graph, top to bottom, with the editor under it. Beside the plan: the subagents as a tree, the background tasks, what you sent to Claude (*Waiting* until Claude reads it, then *Read*), and the session's totals. It follows plans: while one has open steps it refreshes every second and a half (while the tab is visible); with none it rests, checks every 10 seconds for the next plan, and lets the board's server stop after 30 idle minutes.
- **Stats**: sessions, agent time, cost and tokens with sparklines and the change against the previous period; a chart per day stacked by project (Agent time / Cost / Tokens, 7d / 30d / 90d / All); every session in a searchable table; a 12-week activity map, active days, streak, busiest day, longest session and averages. The project list on the left filters everything.

### `/board-import`

Adds your past sessions to the statistics, from Claude Code's own transcripts (`~/.claude/projects`), plus the rows of ponytail's band ledger if you used it. Run it once; running it again only adds what is new.

## How Claude keeps the checklist current

- omniboard gives Claude a tool, `mcp__omniboard__plan`, whose description tells it when to use it: when it carries out an approved plan or any task of three steps or more, it sets the plan, then marks each step started and done. Steps it will run at the same time (subagents started together, say) go in as parallel steps, `2a`, `2b`, ... The tool never asks you for permission.
- When you approve a plan in plan mode, Claude is reminded to load it into the checklist before starting.
- **Claude can change the plan as the work demands**: insert a new step, add a micro-step, rename, skip, restore, remove or reorder steps; the checklist and the board follow at once. The same locks apply to it as to you, and the steps you added or changed are yours: Claude has to ask you before renaming, skipping or removing them.
- **Your edits reach Claude for certain**: a short note ("The user changed your plan: added step 4.1 …") plus the updated plan is attached to the result of Claude's very next action, whatever tool it uses, or to your next prompt if it is idle. Claude reads it exactly once.
- **Claude cannot close the plan past your additions**: marking the last step done is refused while a step you added or changed is still open.
- **Finished work is locked**: once a step is done, its section can no longer be edited and gets no new micro-steps; nothing can be moved across work that has started. The pane and the board only offer what is allowed, and every edit is checked again when it is applied.

If Claude uses its own todo tool instead, the checklist mirrors it.

## Statistics: what the numbers mean

| Number | Live sessions | Imported sessions |
| --- | --- | --- |
| Cost | Claude Code's own session cost (what `/cost` shows) | Claude Code's cost record in the transcript |
| Tokens | Input, output and cache tokens of every turn, subagents included | Same, from the cost record |
| Agent time | Wall time of Claude's turns, from your prompt to its answer | Time spent in API calls and tools, from the cost record |
| Turns | Prompts you sent | Prompts you typed |

The two measures of agent time are close but not identical. A transcript without a cost record (rare, very old or empty sessions) is imported with tokens but no cost.

## Privacy and safety

- Everything stays on your machine, in `~/.claude/omniboard/` (`sessions.csv`, the ledger; `live.json`, written only while the board is open). Delete the folder to start over.
- The board's server listens on `127.0.0.1` only, on a random port, behind a random token in the address. It accepts plan edits only from its own page, checks every edit, and stops with the session or after 30 minutes without requests. It never runs anything a page sends.

## Limits

- **Background tasks**: their end is taken from Claude Code's completion notices and the list it gives at each stop, so a task can show as running for a moment after it ends.
- **Workflow subagents** are counted in the session's tokens but not listed one by one.
- **Parallel steps** move together: you can edit, skip or add micro-steps to each branch, but not reorder a branch on its own.
- **The browser board closes with the Claude Code session** that opened it; `/board` opens it again.
- **The terminal** has no SVG, so the checklist's graph there is a line of text; the list and its actions are the same.

## License

[MIT](LICENSE)
