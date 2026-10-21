---
name: check-in-app
description: Verify a claude-term UI change in a real running dev build — start an isolated dev instance, open Mission control / the file window / the status bar, read DOM text and take screenshots over CDP, then stop it. Use after changing anything the user sees, before saying a UI change works.
---

# Check a change in a running claude-term

Two committed scripts do all the work — never write ad-hoc CDP scripts or
scratch folders for this. Both are allowed in `.claude/settings.local.json`
(and run outside the sandbox), so they need no approval.

```bash
scripts/dev-instance.sh start [project-dir] [port]   # waits until CDP answers; default port 9340
node scripts/cdp.mjs list                            # window titles
node scripts/cdp.mjs eval "<title regex>" "<js>"     # awaited result as JSON
node scripts/cdp.mjs shot "<title regex>" "$TMPDIR/claude-term-devdrive/x.png" ["<js first>"]
node scripts/cdp.mjs type "^Terminal" "claude"       # type + Enter into the terminal
node scripts/cdp.mjs key "<title>" "ctrl+Space"      # one real key press (meta+Enter, Escape, Tab, ArrowDown…)
scripts/dev-instance.sh log                          # dev server / main-process output
scripts/dev-instance.sh stop
```

`WAIT_MS=12000 node scripts/cdp.mjs …` delays before acting. Read screenshots
with the Read tool; send them to the user only when asked.

## Recipes

- **Mission control**: `shot "^Terminal" … "window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',metaKey:true})); 1"`;
  chips as text: `eval "^Terminal" "[...document.querySelectorAll('.mission-chips')].map(e=>e.innerText).join(' | ')"`.
- **Status bar**: hidden in a plain shell tab — `type "^Terminal" "claude"` first
  (starts a session; nothing is sent, so no usage), then `eval … ".status-bar"`.
- **File window**: `eval "^Terminal" "(async()=>{const t=await window.claudeTerm.createTab('<dir>'); await new Promise(r=>setTimeout(r,1500)); window.claudeTerm.openDocsWindow(t.tabId,'docs','x',{path:'<abs file>',edit:true}); return 1})()"`,
  then target it with `"File editor|docs=1"` (its title is the URL until it has loaded).
- **The file editor (Monaco)**: dev builds expose `window.__fileEditor` and
  `window.__monaco` in the file window. Place the cursor or selection with
  `__fileEditor.setPosition/setSelection`, `focus()` it, then press real keys
  with `cdp.mjs key` (Ctrl+Space, Enter, Tab and Escape reach Monaco this
  way). Read results from the model (`getModel().getLineContent(n)`) and the
  DOM (`.suggest-widget .monaco-list-row`, `[class*=ghost-text]`).
- **An IPC call end to end**: `eval "^Terminal" "window.claudeTerm.<method>(…)"`.
- **Another project**: pass its folder to `start`; the profile is fresh each start.

## Gotchas (each cost real time once)

- **Wait for the lookups.** PR, CI and Jira state arrive on the 10 s git poll
  after a cache miss — a first look right after `start` shows "no PR". Use
  `WAIT_MS=12000`.
- **Keychain prompt blocks everything.** An encrypted Jira token in the profile
  makes the main process wait on a macOS keychain dialog, and CDP stops
  answering. The script only copies the token when it is stored unencrypted.
- **First Monaco open reloads the window** in dev ("optimized dependencies
  changed. reloading") and can close the file window — open it again.
- **Typing text into Monaco doesn't work** (`Input.insertText` never lands);
  single key presses via `cdp.mjs key` do. Set text with
  `__fileEditor.getModel().setValue(…)` instead.
- **After editing main-process code, stop and start again.** The dev build
  restarts Electron by itself, but the new process can't get the debug port
  while the old one still holds it, and CDP stops answering.
- **Your own `npm run dev` can run alongside.** The script uses its own
  renderer port (debug port + 100) and `stop` only ends what `start` began.
- **Never `git checkout <file>`** to drop a debug line — it reverts every
  uncommitted change in that file. Remove the line with an edit instead.
- Live checks of main-process code against real APIs: a temporary
  `src/__live/*.test.ts` run with `npx vitest run src/__live/…` works (vitest
  hides console output — write results to a file); delete the folder after.
