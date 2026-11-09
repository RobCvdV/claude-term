# Internals

How claude-term hooks into Claude Code, and the traps it works around. The README has the
short version.

## Session detection

Each tab is a plain login shell in a PTY. For zsh, the tab gets a private `ZDOTDIR` whose
`.zshrc` sources your real `~/.zshrc` and then defines a `claude` function that adds the app's
`--settings` overlay. A shell function beats a `PATH` lookup, so this holds even when your config
reorders `PATH`. Its `.zshenv` resets `ZDOTDIR` in case your config changes it. Non-zsh shells
fall back to a `PATH` shim. Nothing in `~/` is modified (`src/main/settings-overlay.ts`).

## The settings overlay

The overlay is per session and never touches `~/.claude/settings.json`
(`src/main/hook-config.ts`):

- `statusLine` points at a small forwarder script, installed into userData, that POSTs the
  statusline JSON to a local HTTP server in the main process. The TUI's own statusline is
  suppressed for app sessions.
- `type: "http"` hooks — `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
  `Elicitation`, `SessionEnd` — drive the per-tab activity state. `SessionStart` / `SessionEnd`
  show and hide the Claude UI.
- `PermissionRequest` and a matcher-scoped `PreToolUse` run on a long timeout. Those two can be
  _held open_, which is how a prompt gets answered from somewhere other than the terminal (see
  [companion.md](companion.md) and `src/main/companion/parked-prompts.ts`).

Prompts are injected as bracketed-paste text followed by `\r`.

## The term-bridge mod

The launcher passes `--plugin-dir` for the bundled **term-bridge** mod (`resources/term-bridge`).
It runs inside the session and:

- reports who holds Claude Code's keyboard — a dialog, a menu, no input line, or the plain
  prompt — plus slash-command start and end. Focus follows that instead of guessing from the
  screen; screen scraping stays as the fallback for sessions without the mod.
- holds questions and re-asks expired permissions for the companion.

Its events and the app's focus moves are logged side by side to `ui-bridge.log` in userData.

## Focus rules

- `PermissionRequest` / `Elicitation` in the **active** tab move focus to the terminal. The
  generic `Notification` hook is deliberately ignored: it also fires after 60 s idle and as a
  post-`Stop` "waiting for input" ping, which would yank focus mid-typing and leave tabs stuck
  in needs-attention.
- Focus returns to the box on the transition _into_ idle (`Stop`). Git and statusline updates
  carry the same activity and are ignored.
- Overlays like `/usage`, `/config`, `/help` and `/model` close on `Esc` without firing any
  hook. So `Esc` in the terminal is forwarded to the PTY (xterm's
  `attachCustomKeyEventHandler` returning `true`), and then, if the tab is idle, focus hops back
  to the box. Gated on idle so `Esc` that interrupts a turn or cancels a dialog is left alone.
- On a tab switch, a tab with a pending dialog lands you in its terminal, any other session in
  its box, and a plain terminal in the terminal.

## Undo a turn

Every prompt snapshots the repo with `git stash create`: a commit object holding the working
tree, written without touching the index or the stash list, pinned by a ref under
`refs/claude-term/` so `git gc` can't drop it. A clean tree needs no commit — HEAD _is_ the
restore point. Ten restore points are kept per tab and every ref is deleted on quit.

**This turn** is read from the session transcript: the files its `Edit` / `Write` /
`MultiEdit` / `NotebookEdit` calls touched. A turn is matched to its restore point by time rather
than by counting back, because app-injected prompts (a `/rename`, a branch-switch note) take a
checkpoint without leaving a user message behind. A turn with no match says so and can't be
reverted.

## Prompt-box completion

- `/` suggestions come from the built-ins, `~/.claude/commands`, `~/.claude/skills`, the
  project's `.claude/` and enabled plugins, with their frontmatter descriptions.
- `@` suggestions come from `git ls-files` (untracked included), or a bounded walk outside git.
  `@../`, `@/` and `@~/` list one level per popup and never recurse; `~` completions become
  absolute paths, the form Claude Code reliably parses.
- Results re-query on every keystroke (`incomplete: true`), backspace included, so deleting
  widens the results and reopens a closed popup.

## Find in the conversation

Claude Code draws on the terminal's alternate screen buffer, which keeps no scrollback. So `⌘F`
searches the transcript (`~/.claude/projects/<project>/<session>.jsonl`) instead, read
incrementally — only what was appended since the last search — which keeps a 60 MB conversation
cheap. The parse cache is shared with the companion's conversation follower.

## Gotchas

- **node-pty's `spawn-helper`** ships without `+x`; `postinstall` chmods it (otherwise
  `posix_spawnp failed`).
- **The statusLine command runs through a shell**, and userData is under `Application Support`
  (with a space), so the overlay quotes the forwarder path.
- **Resume** uses the tab's recorded `session_id` (`--resume <id>`), never `claude -c`, which would
  grab the most recent session in that folder — possibly someone else's.
- **Monaco completion popups**: with a custom `wordPattern` that includes `/` and `@`, trigger
  characters go down the _quick suggest_ path (`LineContext.shouldAutoTrigger`), so
  `quickSuggestions` must be on. `fixedOverflowWidgets: true` is required because the box sits
  at the bottom of the window in an `overflow: hidden` wrapper. Editor options only apply on
  creation — restart the app after changing them; HMR won't recreate the editor.
- **Monaco Enter-to-submit**: `editor.addCommand(KeyCode.Enter, …)` does not work — the
  EditContext input pipeline turns Enter into a newline before the keybinding fires. Intercept it
  in `editor.onKeyDown` with `preventDefault()`, and skip when `.suggest-widget.visible` so Monaco
  can accept the suggestion. Other keys like `⇧Tab` are fine via `addCommand`. Synthetic CDP key
  events don't feed the EditContext, so `⇧Enter` newlines can't be exercised over CDP.
- **`/add-dir` can only be seen as it is submitted.** Claude Code keeps no readable record of a
  runtime `/add-dir` — not in the statusline payload, the transcript or `~/.claude.json`. The file
  window learns extra roots from `permissions.additionalDirectories` in the settings chain and from
  `/add-dir <path>` passing through the prompt box. One typed directly into the terminal can't be
  seen; put it in `permissions.additionalDirectories` to make it stick. `/remove-dir` drops a
  folder from the tab's record and remembers the removal, but Claude Code has no removal command,
  so the running session keeps access until the tab restarts.
- **Profile isolation** (2026-07-21 incident): package name and productName are both
  `claude-term`, so a dev run once shared the installed app's userData and a quitting dev instance
  overwrote the real `session.json`. Now dev runs use `claude-term-dev`, packaged runs with a CDP
  port use `claude-term-debug`, `CLAUDE_TERM_USER_DATA_DIR` overrides both, and a single-instance
  lock stops two instances sharing a profile. Every distinct `session.json` is also snapshotted to
  `session-backups/` (last 20).
- **An `http` hook can answer a permission prompt.** Withholding the response parks that one
  decision (the turn waits, other hooks keep firing); a 2xx body of
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  releases it, and an empty 2xx body means "no decision". Three traps: `PermissionRequest` answers
  with `decision.behavior` while `PreToolUse` uses `permissionDecision`; the native dialog is drawn
  immediately, in parallel with a parked hook, and answering there closes the parked connection;
  and only `PreToolUse`'s `permissionDecisionReason` reaches the model, so it is the only way to
  send back an `AskUserQuestion` answer or plan feedback. `Elicitation` is MCP-only and never fires
  for these. Measured against CLI 2.1.235 — see [companion-hook-protocol.md](companion-hook-protocol.md)
  and re-run `scripts/hook-spike/tui.py` after a CLI upgrade.
