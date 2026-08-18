# claude-term

Personal Electron wrapper around the Claude Code CLI (tabs, Monaco prompt box,
app-rendered statusline, file window). Not a MendriX product repo.

## Keyboard shortcuts are documented in five places — keep them in sync

Whenever a change adds, removes or rebinds a key (window-level handler in
`App.tsx`, a Monaco `addCommand` in `PromptBox.tsx` / `file-editor.ts`, an xterm
handler in `term-registry.ts`, a menu accelerator), walk this list in the same
change — the cheat sheet and the placeholder have drifted before:

- `src/renderer/src/components/HelpOverlay.tsx` — the **Quick How-To** cheat
  sheet (`<Keys k="…">` rows, ⌘/) and the **User Guide** prose below it.
- `src/renderer/src/components/PromptBox.tsx` — the empty-box **placeholder**
  line. It is the only hint most sessions ever read, so it lists the box's own
  keys; keep it short and true rather than complete.
- `src/renderer/src/App.tsx` — `paletteActions`, whose `shortcut:` labels are
  shown in the ⌘K palette.
- Tooltips: `title=` on the buttons that have a key (tab bar, status bar chips).
- `README.md` — the feature list quotes keys throughout.

Write a shortcut the way the app already writes it (`⇧⌘A`, `⌥Tab`, `⌘[ ⌘]`), and
if a key is only reachable from the palette or a chip, say so instead of
inventing one.
