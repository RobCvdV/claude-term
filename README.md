# claude-term

A desktop terminal built around the [Claude Code](https://claude.com/claude-code) CLI.

Every tab is a **plain terminal**: your own login shell, used as normal. Run `claude` in it and
the tab grows a Claude UI — a multiline prompt box, a live status bar and side windows for files
and diffs. Quit `claude` and the UI disappears again. Your `~/.claude` config is never touched.

Built with Electron, xterm.js, node-pty and Monaco. Personal tool; the Jira, Bitbucket and Jenkins
integrations are tuned for MendriX work (MTX tickets).

- [Highlights](#highlights)
- [Install](#install)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How it works](#how-it-works)
- [Develop](#develop)
- [Where things are stored](#where-things-are-stored)

## Highlights

- **Prompt box** — a real editor under the terminal: multiline, spell + grammar check,
  `/` command and `@` file completion, history.
- **Live status bar** — activity, branch and ticket, PR review, CI, context use and rate limits.
- **Mission control** (`⌘E`) — every tab and repo at a glance, with what needs you.
- **Focus follows the conversation** — dialogs take the keyboard, finished turns hand it back.
- **Undo a turn** — every prompt snapshots the repo; revert exactly what a turn wrote.
- **File window** — plans, docs, config and the project tree, with Finder-style keys and a
  Monaco editor that can ask Claude to complete or rewrite text.
- **Sessions survive** — tabs, windows and Claude sessions come back after a restart.
- **Phone companion** — answer prompts and follow sessions from your phone, over Tailscale.

## Install

Download the latest build from
[Releases](https://github.com/RobCvdV/claude-term/releases/latest): `.dmg` (macOS), `.exe`
(Windows) or `.AppImage` (Linux). Packaged builds check for updates in the background and offer
to install them.

You need the `claude` CLI on your `PATH`.

## Features

### Tabs and windows

- `⌘T` opens a terminal in your home folder, `⌘O` in a folder you pick.
- A tab is named after its folder: the shell's current one (follows `cd`, zsh only), or the
  session's folder while `claude` runs. Rename it from its right-click menu, tint it with `/color`.
- The dot on a tab shows its state:

  | Dot          | Meaning                                                       |
  | ------------ | ------------------------------------------------------------- |
  | hollow       | plain terminal                                                |
  | green        | Claude session, idle                                          |
  | orange       | Claude session, busy                                          |
  | yellow       | Claude session, needs input                                   |
  | pulsing cyan | something still running outside a turn (shown as `▶ command`) |

- Drag a tab to reorder it; `⌘1 …9` follow the new order.
- `⌘N` opens another window. Move a tab — with its session still running — with `⇧⌘N` (new
  window), `⇧⌘M` (back to the main window), its menu, or by dragging it to another window's tab
  bar. `` ⌃` `` steps through terminal windows.
- **Window ▸ Tab Shortcuts Stay in Their Window** (on by default) keeps `⌘1 …9` and `⌘[ ⌘]`
  per window. **Window ▸ Restore Window Positions** can be turned off if a window manager places
  windows for you.
- Wherever `claude` is started becomes the tab's home for that session (status bar, file tree,
  `@` completion, resume). A `/cd` inside the session never moves it.

### The prompt box

- `Enter` sends, `⇧Enter` adds a newline. Typing straight into the terminal still works.
- `/` completes slash commands: Claude Code's own, your commands, skills and plugins, and the
  app's own commands:

  | Command       | What it does                                                              |
  | ------------- | ------------------------------------------------------------------------- |
  | `/color`      | tint the tab (`/color orange`)                                            |
  | `/switch`     | switch to a local branch and rename the session to match                  |
  | `/npm`        | list the project's npm scripts; `Enter` runs one, `Tab` lets you add args |
  | `/add-file`   | create a file (`/add-file docs/plan.md`) and open it in the file window   |
  | `/add-dir`    | add a folder to the session, completed one level at a time                |
  | `/remove-dir` | take an added folder back out of the tab                                  |

- `@` completes project files (git files, untracked included). `@../`, `@/` and `@~/` browse
  one folder level at a time.
- `↑ ↓` walk your prompt history; `←` on an empty box opens Claude Code's agents overview.
- `Tab` on an empty box runs Claude's grayed-out suggested next prompt.
- Misspelled words get a muted underline; `⌘.` lists fixes and **Add to dictionary**.
- `⌃R ⌃O ⌃T ⌃B` go to Claude Code. The box keeps its own editing keys (`⌃A ⌃E ⌃K ⌃H ⌃D ⌃F ⌃N ⌃P`
  and `⌃Z`).

### Status bar

Left to right:

- **Activity** — busy (with a timer), needs input, or idle.
- **Folders** — the tab's folder plus every other folder the session works in.
- **Git** — branch (linked to the repo; the MTX ticket linked to Jira), a dot for the ticket's
  Jira status (opt-in in Settings), and changed / ahead / behind counts. Click `~N` to
  [undo a turn](#undo-a-turn).
- **Model** and reasoning effort.
- **Context** use — orange from 60%, red from 78%.
- **Rate limits** — 5-hour and 7-day windows with time to reset. Hover for a burn forecast;
  they turn orange early when the current pace runs out before the reset.
- **Editor windows** — `plan`, `roadmap`, `docs` and `settings` open the [file window](#file-window).
- **CI links** — Jenkins (TMS repos), CircleCI or GitHub Actions, with a live build dot and
  progress while building.
- **PRs**, with a dot for the branch's review state: orange awaiting review, green approved,
  red changes requested, blue merged, grey no PR.
- **Jira**, **Releases** or **Downloads**, notification volume and the clock.

The PR, Jira, branch and folder chips open a dropdown on a click or right-click (never on hover):

- **Branch** — every workspace repo's local branches, newest first, with yours marked **mine**.
  Click to switch (the session is told to re-read files); right-click opens it on
  Bitbucket/GitHub.
- **Jira** — in the driver repos, the To Do tickets for that repo's labels that are unassigned or
  yours. Right-click → **Start Branch** creates or switches to the ticket's branch, assigns the
  ticket to you, moves it to Active and asks the session for a first look.

### Mission control

`⌘E` shows every tab: activity, elapsed time and context use, and per repo the branch, Jira
status, topic (ticket summary or PR title), PR review and comments, build state and unpushed /
behind counts — plus your last prompt and a summary of Claude's latest reply.

- The header counts what needs you; a card with a failed build, requested changes or a question
  gets a red edge. Click a card to jump to its tab.
- **ready to merge** marks an approved, green PR with nothing unpushed, with a button to move its
  ticket from Peer review to Deploy.
- **rebase?** (orange) marks a PR'd branch far behind main; the threshold is in Settings.
- **⚠** flags a ticket lagging its branch, with a one-click move where the next stage is obvious.
  Every move asks first.
- **Waiting on your review** lists other people's open PRs that name you.

### Focus follows the conversation

- A permission prompt or question picker gives the terminal the keyboard, so arrows and `Enter`
  work at once. A `/command` sent from the box does the same, for menus like `/model`.
- When the turn finishes, focus returns to the prompt box. So does `Esc` out of an overlay like
  `/usage` or `/config`.
- Switching tabs lands you in the box, or in the terminal if that tab has a dialog open.
- `⌥Tab` hops between box and terminal by hand. `⌘⇧A` (and the **N waiting** pill) walks
  through every tab that's waiting on you.

### Find in the conversation

`⌘F` searches the session's whole transcript — not just the visible screen, which is all the
terminal has, since Claude Code's TUI keeps no scrollback. Newest hit first, with who said it
and when. `+ tools` widens the search to tool calls, their output and thinking. The **screen**
chip switches back to a plain terminal search.

### Undo a turn

Every prompt you send snapshots the repo first (`git stash create`; your index and stash list are
untouched). Click `~N` in the status bar to open the diff window:

- **This turn** shows the files the turn's edit tools wrote; **All** shows everything that
  differs from HEAD. A dropdown steps back up to ten turns.
- **Revert** restores exactly those files: files the turn created are deleted, files that were
  already untracked are left alone, your own edits elsewhere are untouched. It confirms first.
- Restore points last as long as the app runs. Files changed by a command Claude ran (an install,
  codegen) show only under **All** — undo those with git.

### File window

One window per tab for everything the project has to read and edit.

- **Rail** — a **Quick Access** group (plans, `ROADMAP.md`, the project's markdown, config files)
  above a tree per project folder. Names use WebStorm's git colours, source files get a type
  badge, and the rail's width is draggable.
- **Search** — the box narrows Quick Access and finds any file under the project by name; `*`
  and `?` make it a pattern (`*.md`, `plan*`). The ≡ button (or `⇧⌘F` again in the box)
  searches inside text files instead — binaries are skipped — listing each matching line; opening
  one selects the match.
- **Keys like Finder** — arrows walk the tree, typing jumps to a name, `Space` Quick Looks,
  `⌘C`/`⌘V` copy and paste files with Finder (never overwriting). See the
  [shortcuts](#file-window-1).
- **View or Edit** — markdown renders, images show on a checkerboard, HTML renders sandboxed.
  Everything else opens in Monaco with highlighting for its type; JSON is validated.
- **Saving** — `⌘S`; a dot marks unsaved changes. Files changed on disk (by Claude, by git)
  reload within ~2 s, or offer **Reload from disk** / **Keep mine** if you have edits.
- **Claude in the editor** — `⌃Space` asks Claude (Haiku) for the text at the cursor; it appears
  as the top suggestion, and `Tab` inserts it. With a selection, `⌃Space` rewrites it from a
  one-line instruction, shown as a diff — `⌘↵` applies it. Both run on your own login and count
  against your plan.
- Files over 2 MB ask before opening. The config list is tunable via `config-file-patterns.json`
  in the rail.

### Branches, tickets and the palette

`⌘K` jumps to a tab (by title, folder or branch), runs an app action, or **recalls a branch** you
worked on: every branch seen in any tab is remembered, and a repo's `git reflog` is mined the
first time it shows up — so typing `MTX-10302` finds a branch from weeks ago. `Enter` copies its
name.

### Activity hours → Jira

The 🕐 view (tab bar, top right) shows engaged time per day and per MTX ticket, logged by a hook
while you work. Connect a Jira API token once and book the suggested worklogs from the panel.

### Settings and notifications

`⌘,` holds the switches: macOS notifications (PR approved, changes requested, comments, ready to
merge, review requested, build failed or fixed, ticket moved, needs input), the Jira status
lookup, CI polling, the review list, the behind-main threshold, window and tab behaviour,
keep-awake, spell check, volume, and which services have credentials. Jira connects here; other
tokens are read from your login shell.

### Sessions that survive

- Tabs, windows, colours, titles, prompt drafts and history are saved. On launch every tab comes
  back and its Claude session is resumed in its own folder — background agents are re-attached,
  not restarted.
- While any session is busy, and for 10 minutes after, the Mac won't idle-sleep. The display
  still can, and closing the lid still sleeps.
- If the shell itself exits, the tab offers **New shell** or **Close tab**.

### Phone companion

The [claude-term companion](https://github.com/RobCvdV/claude-term-companion) app (iOS/Android)
lists the Mac's sessions, follows their conversations, answers their prompts and sends new ones.

- Reachable **only over Tailscale**; devices authenticate with an Ed25519 challenge, so no token
  or password ever crosses the wire.
- Pair with **⌘K → Phones — pair or revoke…**: a QR and a code, valid for two minutes and one
  device. The same panel revokes devices.
- Prompts are always still answerable in the terminal; whichever side answers first wins.
  Nothing is auto-approved.
- Paired phones get a push when a tab starts waiting, a long turn finishes or a session ends —
  with only the title and folder name in it.

The details are in [docs/companion.md](docs/companion.md).

## Keyboard shortcuts

`⌘/` shows the cheat sheet in the app.

### Tabs and windows

| Keys         | Action                               |
| ------------ | ------------------------------------ |
| `⌘T`         | New tab (home folder)                |
| `⌘O`         | New tab in a chosen folder           |
| `⌘W`         | Close tab                            |
| `⌘1 …9`      | Jump to tab 1–9                      |
| `⌘[ ⌘]`      | Previous / next tab                  |
| `⌘N`         | New window                           |
| `⇧⌘N`        | Move the tab to a new window         |
| `⇧⌘M`        | Move the tab back to the main window |
| `` ⌃` ``     | Next terminal window                 |
| `⌘K`         | Command palette                      |
| `⌘E`         | Mission control                      |
| `⌘,`         | Settings                             |
| `⌘⇧A`        | Next tab waiting for input           |
| `⌘F`         | Find in the conversation             |
| `⌘= ⌘-` `⌘0` | Zoom in / out, actual size           |

### Prompt box

| Keys     | Action                                    |
| -------- | ----------------------------------------- |
| `Enter`  | Send                                      |
| `⇧Enter` | Newline                                   |
| `/` `@`  | Command and file completion               |
| `↑ ↓`    | Prompt history                            |
| `Tab`    | Run Claude's suggested prompt (empty box) |
| `←`      | Agents overview (empty box)               |
| `⇧Tab`   | Cycle the permission mode                 |
| `⌥Tab`   | Toggle focus between box and terminal     |
| `Esc`    | To Claude Code, and focus the terminal    |
| `⌘L`     | Focus the prompt box                      |
| `⌘.`     | Spelling fixes                            |

### File window

| Keys        | Action                                                  |
| ----------- | ------------------------------------------------------- |
| `⇧⌘F`       | Find a file (`⌘F` too, outside the editor)              |
| `⇧⌘F` again | In the box: search inside text files (≡ button too)     |
| `↑ ↓ → ←`   | Move; open / close folders, step in / out               |
| `a`–`z`     | Jump to the next name starting with what you type       |
| `↵`         | Open in the editor                                      |
| `Space`     | Quick Look                                              |
| `⌘O`        | Open with the default app                               |
| `⌘C` `⌘V`   | Copy and paste files with Finder                        |
| `⌥⌘C`       | Copy the path                                           |
| `⌃Space`    | Context menu in the tree (right-click too)              |
| `⌘L` / `⌘E` | To the tree / to the editor                             |
| `⌥⌘L`       | Select the open file in the tree                        |
| `⌘P`        | Switch between View and Edit                            |
| `⌘S`        | Save                                                    |
| `⌃Space`    | In the editor: Claude completion, or edit the selection |
| `⌘↵`        | Apply Claude's edit                                     |

## How it works

1. **Detection without touching your config.** Each tab's zsh gets a private `ZDOTDIR` whose
   `.zshrc` sources your real one, then defines a `claude` function that adds a `--settings`
   overlay. Other shells get a `PATH` shim instead.
2. **The overlay** routes Claude Code's `statusLine` and hooks to a local HTTP server in the app.
   `SessionStart` / `SessionEnd` show and hide the Claude UI; the other hooks drive activity,
   focus and the companion.
3. **Prompts** are written to the PTY as bracketed paste followed by `Enter`.
4. **The term-bridge mod** (`resources/term-bridge`, loaded with `--plugin-dir`) runs inside the
   session and reports who holds Claude Code's keyboard — a dialog, a menu or the prompt — so
   focus can follow it.

More detail, and the traps met along the way, in [docs/internals.md](docs/internals.md).

## Develop

```bash
npm install
npm run dev          # dev app with HMR and a main-process watch
npm test             # vitest
npm run typecheck && npm run lint
npm run build:mac    # packaged app via electron-builder (also build:win, build:linux)
```

| Variable                    | Effect                                                   |
| --------------------------- | -------------------------------------------------------- |
| `CLAUDE_TERM_DEFAULT_CWD`   | Open a tab in this folder on start (skips the picker)    |
| `CLAUDE_TERM_USER_DATA_DIR` | Use this profile folder                                  |
| `CLAUDE_TERM_DEBUG_PORT`    | Open a Chrome DevTools Protocol port                     |
| `CLAUDE_TERM_E2E=1`         | Include the end-to-end tests (needs the `claude` binary) |

- `scripts/dev-instance.sh` and `scripts/cdp.mjs` start an isolated dev instance and drive it
  over CDP — used to check UI changes in a real build.
- Every push to `main` builds and publishes a release. The version comes from the commit
  messages: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE` → major.

## Where things are stored

Everything lives in the app's userData folder (`~/Library/Application Support/claude-term` on
macOS). Dev runs use `claude-term-dev`, so they never touch your real tabs.

| File                        | Contents                                              |
| --------------------------- | ----------------------------------------------------- |
| `session.json`              | Open windows, tabs and their sessions                 |
| `session-backups/`          | The last 20 versions of `session.json`                |
| `config-file-patterns.json` | Which config files the file window lists              |
| `companion-devices.json`    | Paired phones (public keys only)                      |
| `ui-bridge.log`             | Focus moves and term-bridge events                    |
| `companion.log`             | Every prompt held for a phone and what happened to it |

To recover lost tabs, quit the app and copy a file from `session-backups/` over `session.json`.
