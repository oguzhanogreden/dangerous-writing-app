# Start Here

This project uses **bd (beads)** for issue tracking — do not use TodoWrite,
TaskCreate, or markdown TODO lists for task tracking here.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
bd prime              # Full command reference + session close protocol
```

For everything else — coding conventions, Val Town platform specifics,
project structure, and the full beads workflow — see **[AGENTS.md](./AGENTS.md)**.

## Session state pattern: Task / Stage / Section

`client.js` models "where the app is right now" as one global mutable
object, `Task = { stage: Stage }`, and derives layout from it through an
explicit mapping table rather than scattered `if`s. If you add a new session
state or a new layout region, follow this shape rather than inventing a
parallel mechanism:

- **`Stage`** — a closed set of strings naming points in the session
  lifecycle (currently `LAND | COUNTDOWN | WRITE | DONE | FIRST_DEMO`).
  `Task.stage` is always exactly one of these. This is "what's happening."
- **`Section`** — a closed set of strings naming which UI region is enlarged
  in the mobile zoom layout (`begin | stage | controls | entries`), applied
  via a `data-active` attribute on `<main>` that CSS reads. This is "what's
  on screen" — a separate axis from Stage, because during `LAND` the writer
  can move between sections freely (tapping a slider shows `controls`) while
  every other stage locks the layout onto one section regardless of input.
- **`STAGE_LAYOUT: Record<Stage, Section | null>`** — the single place Stage
  and Section are wired together. `null` means "don't override, leave
  whatever's currently active." Because this is a `Record` over every
  `Stage` key, adding a stage without adding its entry here is a type error
  (checked via JSDoc, see below) — the mapping can't silently fall through.
- **`setStage(stage)`** is the only function that should mutate
  `Task.stage`. It updates the global, persists to `localStorage`, and
  applies `STAGE_LAYOUT[stage]`. Don't set `Task.stage` directly from
  elsewhere.
- **Persistence is opt-in per stage.** Only stages with no live, unresumable
  side effect (currently `LAND`, `DONE`) are restored from `localStorage` on
  reload — see the whitelist in `restoreTask()`. Transient stages
  (`COUNTDOWN`, `WRITE`, `FIRST_DEMO`) have a running timer that can't be
  reconstructed from a page reload, so they're deliberately excluded and
  fall back to `LAND`.
- **Type checking**: this file has no build step and is served to the
  browser as-is, so typing is JSDoc (`@typedef`, `@type`), not `.ts`. The
  global is declared with `var Task = ...` rather than `window.Task = ...`
  — a top-level `var` in a classic script is simultaneously a resolvable
  bare identifier (so JSDoc/tsc can trace it) and a `window` property (so
  it's inspectable as `window.Task` in devtools). There's no `// @ts-check`
  pragma in the file (the rest of the file predates typing and would surface
  many unrelated `HTMLElement`-generic errors); check this section's typing
  on demand instead: `npx tsc --allowJs --checkJs --target es2020 --lib
  dom,es2020 --noEmit client.js`, then filter for `Stage`/`Section` in the
  output.
- **`GET /debug`** (in `main.ts`) surfaces server state (auth, saved-session
  count) plus the client's persisted `localStorage` — useful when there's no
  devtools console handy (e.g. testing on a phone). It cannot show live
  in-memory state (`Task.stage` during an active `COUNTDOWN`/`WRITE`), only
  what's been persisted — that's only inspectable via `window.Task` in the
  `/` page's own console.
