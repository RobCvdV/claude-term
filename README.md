# claude-term

A macOS/cross-platform Electron app that runs the **real, unmodified Claude Code CLI** in an embedded terminal (xterm.js + node-pty) and adds around it:

- **Multiline prompt box** below the terminal (Monaco editor) — Enter sends (injected into the running session via bracketed paste), Shift+Enter for a newline, Shift+Tab cycles permission modes, Esc focuses the terminal, ⌘K focuses the box. Typing directly in the terminal keeps working as normal.
- **Autocomplete in the prompt box** — typing `/` pops VS Code-style suggestions for slash commands (built-ins + `~/.claude/commands` + `~/.claude/skills` + project `.claude/` + enabled plugins, with frontmatter descriptions); typing `@` suggests project files (`git ls-files` incl. untracked, bounded walk for non-git folders). `@../` switches to shell-tab-style navigation: one directory level per popup (never recursive, so climbing parents stays cheap), accept a folder to descend. Suggestions re-query the backend on every keystroke (`incomplete: true`), including backspace — deleting characters widens the results and re-opens a closed popup. Enter accepts a suggestion while the popup is open, sends otherwise. `@path` mentions are expanded by Claude Code on submit (verified: attaches the file).
- **Always-fresh statusline bar** (HTML, refreshes every second) fed by Claude Code's `statusLine` hook and http hooks: activity (busy/idle/needs input + elapsed), folder, git branch with MTX-ticket highlight and Bitbucket link, git `~/↑/↓` stats, model + effort, context % (orange ≥60, red ≥78), session cost, rate-limit windows with reset countdown, Jira/Jenkins links, clock. The in-TUI statusline is suppressed for app sessions.
- **Auto-focus the terminal when it needs the keyboard** — sending a `/command` from the box hands focus to the terminal (so `/model`, `/config` etc. menus are immediately arrow/Enter-drivable); and when Claude Code shows a permission prompt or question picker (`PermissionRequest`/`Elicitation` hooks) in the **active** tab, focus moves to the terminal automatically. Deliberately not wired to the generic `Notification` hook (that also fires on 60s-idle and would yank focus mid-typing).
- **Focus follows the tab** — App owns focus on tab switch: switch to a tab with a pending dialog (`needs-attention`) and you land in its terminal (this covers a background tab that raised a dialog while unfocused — its attention dot lights, focus isn't stolen, and you drop into the terminal the moment you switch to it); switch to any other tab and you land in its prompt box, ready to type.
- **Focus returns to the box when the terminal is done** — when the active tab settles back to `idle` (the `Stop` hook: a response, permission dialog, or other TUI interaction just finished), focus snaps back to the prompt box — no ⌘K needed. Fires only on the transition *into* idle (git/statusline updates carry the same activity and are ignored). Note: Claude Code's `Notification` hook is deliberately not tracked as an activity state — it also fires as a post-`Stop` "waiting for input" ping, which would leave tabs stuck `needs-attention` and block this refocus. Real dialogs come through `PermissionRequest`/`Elicitation`, which precede `Stop`.
- **Esc out of an overlay returns to the box** — overlays like `/usage`, `/config`, `/help`, `/model` show inline TUI and close on Esc *without* firing any hook, so the idle-refocus above can't see them. Instead, Esc pressed in the terminal is forwarded to the PTY (Claude Code closes the overlay) and then, if the tab is idle, focus returns to the prompt box. It's gated to idle on purpose: Esc used to interrupt a running response (`busy`) or cancel a permission dialog (`needs-attention`) is left to those flows. Implemented via xterm `attachCustomKeyEventHandler` returning `true` (so the key still reaches the PTY) plus a deferred focus hop.
- **Tabs** — one Claude Code session per tab (own project folder). Double-click a tab to rename it. Activity dot per tab. ⌘T new tab, ⌘W close, ⌘1..9 switch.
- Exit handling: when claude exits in a tab, the scrollback stays and you can Restart, Resume that tab's session (`--resume <id>`), or close the tab.

## How it works

Each tab spawns `claude --settings '<overlay>'` in a PTY. The overlay (per session, never touching `~/.claude/settings.json`) points `statusLine` at a tiny forwarder script (installed into the app's userData dir) that POSTs the statusline JSON to a local HTTP server in the Electron main process, and adds `type: "http"` hooks (SessionStart/UserPromptSubmit/Stop/Notification/SessionEnd) that drive the per-tab activity state. Prompt injection writes bracketed-paste framed text to the PTY followed by `\r`.

## Develop

```bash
npm install
npm run dev            # dev app with HMR + main-process watch
```

`CLAUDE_TERM_DEFAULT_CWD=/some/project npm run dev` auto-opens a tab in that folder (skips the picker).

## Build

```bash
npm run build:mac      # packaged .app via electron-builder
```

## Gotchas encountered (kept working by this repo's config)

- node-pty's prebuilt `spawn-helper` ships without +x → `postinstall` chmods it (otherwise `posix_spawnp failed`).
- The statusLine `command` string runs through a shell and userData is under `Application Support` (space!) → the overlay quotes the forwarder path.
- Resume uses the tab's recorded `session_id` (`--resume <id>`), never `claude -c`, which would grab the most recent session in that cwd — possibly someone else's.
- Monaco: with a custom `wordPattern` that includes `/` and `@`, trigger characters are routed to the *quick suggest* path (`LineContext.shouldAutoTrigger`), so `quickSuggestions` must be ON for the popups to appear; `fixedOverflowWidgets: true` is required because the input sits at the bottom of the window inside an `overflow: hidden` wrapper; editor options only apply on editor creation — restart the app after changing them (HMR won't recreate the editor).
- Monaco Enter-to-submit: `editor.addCommand(KeyCode.Enter, …)` does NOT work — Monaco's text-input (EditContext) pipeline swallows Enter as a newline before the command keybinding fires. Intercept it in `editor.onKeyDown` with `preventDefault()` instead, and skip when `.suggest-widget.visible` (let Monaco accept the suggestion). Non-typing keys like Shift+Tab are fine via `addCommand`; only Enter needs the keydown path. (Note: synthetic CDP key events don't feed the EditContext, so newline insertion on Shift+Enter can't be exercised via `Input.dispatchKeyEvent` — it's stock Monaco behavior driven by real OS keys.)
