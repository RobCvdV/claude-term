import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { TabId } from '../../../shared/types'
import { focusTerm, readInputSuggestion, terminalDialogOpen } from '../term-registry'
import { setupMonaco, modelUriForTab, PROMPT_LANG } from '../monaco-setup'
import { attachSpellcheck } from '../spell'
import { SpellToggle } from './SpellToggle'
import { getArgCompleter, matchAppCommand, picksAndRuns } from '../app-commands'
import { focusAfterSubmit, type FocusState } from '../focus-policy'
import { runFocusLoan, type LoanMode } from '../focus-loan'
import { promptHistoryFor, pushPrompt } from '../prompt-history'
import { draftFor, lastImageNumber, saveDraft } from '../prompt-drafts'
import { suggestWidgetAccepting } from '../suggest-widget'

const MIN_HEIGHT = 64
const MAX_HEIGHT = 240

interface Props {
  tabId: TabId
  disabled: boolean
  // focus the editor as soon as it mounts (box just appeared for an active,
  // dialog-free session). App still owns focus for tab switches / dialogs.
  autoFocus: boolean
  /** the tab's live claude state — read on submit to decide where focus goes */
  focusState: FocusState | null
  onStepTab: (delta: number) => void
  onColor: (color: string) => void
  color?: string
  /** ⌘K — Monaco owns the key while the box has focus, so bind it here too */
  onOpenPalette: () => void
  /** ⌘F — likewise; terminal scrollback search, never Monaco's find widget */
  onFindInTerminal: () => void
  /** ⌘E — likewise; mission control, never Monaco's find-with-selection */
  onOpenMission: () => void
  /** ⌘/ — likewise; the help overlay, never Monaco's toggle-comment */
  onShowHelp: () => void
}

// One dropped attachment: `mention` is what actually gets submitted to claude
// (an @-path it can attach, or a quoted path it can read). Images are shown in
// the box as a compact [imageN] chip instead of their full path.
export interface Attachment {
  mention: string
  isImage: boolean
}

export interface PromptBoxHandle {
  focus: () => void
  insertAttachments: (items: Attachment[]) => void
  /** set the prompt to `text` only when it's currently empty (no clobbering) */
  fillIfEmpty: (text: string) => void
}

// image chips shown in the box; expanded back to their real mention on submit
const IMAGE_TOKEN_RE = /\[image\d+\]/g

export const PromptBox = forwardRef<PromptBoxHandle, Props>(function PromptBox(
  {
    tabId,
    disabled,
    autoFocus,
    focusState,
    onStepTab,
    onColor,
    color,
    onOpenPalette,
    onFindInTerminal,
    onOpenMission,
    onShowHelp
  },
  ref
): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
  const [empty, setEmpty] = useState(true)
  // transient one-line error from an app command (e.g. a failed `/switch`)
  const [cmdError, setCmdError] = useState<string | null>(null)
  const cmdErrorTimer = useRef<number | null>(null)
  const showCmdError = (msg: string): void => {
    setCmdError(msg)
    if (cmdErrorTimer.current !== null) window.clearTimeout(cmdErrorTimer.current)
    cmdErrorTimer.current = window.setTimeout(() => setCmdError(null), 6000)
  }
  const showCmdErrorRef = useRef(showCmdError)
  showCmdErrorRef.current = showCmdError
  // keep the latest handlers for the addCommand/closure below (bound once)
  const stepTabRef = useRef(onStepTab)
  stepTabRef.current = onStepTab
  const openPaletteRef = useRef(onOpenPalette)
  openPaletteRef.current = onOpenPalette
  const findInTerminalRef = useRef(onFindInTerminal)
  findInTerminalRef.current = onFindInTerminal
  const openMissionRef = useRef(onOpenMission)
  openMissionRef.current = onOpenMission
  const showHelpRef = useRef(onShowHelp)
  showHelpRef.current = onShowHelp
  const colorRef = useRef(onColor)
  colorRef.current = onColor
  const autoFocusRef = useRef(autoFocus)
  autoFocusRef.current = autoFocus
  const focusStateRef = useRef(focusState)
  focusStateRef.current = focusState
  // history travel: which entry is showing (null = editing the draft), and the
  // parked draft text restored when travelling forward past the newest entry
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef('')
  // cancels the running focus loan, if any (see focus-loan)
  const loanCancelRef = useRef<(() => void) | null>(null)
  // send routine, hoisted out of the mount effect so the Send button shares it
  const sendRef = useRef<() => void>(() => {})
  // [imageN] chip → the @-path/quoted-path actually submitted. Seeded from the
  // parked draft: the chips are only labels, so losing the map on remount would
  // submit a literal "[image1]". The counter resumes past the restored chips so
  // a newly dropped image can't reuse a label the draft still holds.
  const imageMapRef = useRef(new Map(Object.entries(draftFor(tabId)?.images ?? {})))
  const imageCounterRef = useRef(lastImageNumber(draftFor(tabId)?.images ?? {}))
  // swap every [imageN] chip in the text back to its real mention before submit
  const expandImages = (text: string): string =>
    text.replace(IMAGE_TOKEN_RE, (m) => imageMapRef.current.get(m) ?? m)
  // how many image chips are in the prompt — the PTY layer waits longer before
  // Enter so Claude Code can finish reading each image into an [Image #N] chip
  const countImages = (text: string): number => (text.match(IMAGE_TOKEN_RE) ?? []).length
  const resetImages = (): void => {
    imageMapRef.current.clear()
    imageCounterRef.current = 0
  }

  // shared insert routine: drop `text` at the cursor (replacing any selection),
  // padded so it stays one deletable token
  const insertTokenText = (text: string): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const end = {
      lineNumber: model.getLineCount(),
      column: model.getLineMaxColumn(model.getLineCount())
    }
    const sel = editor.getSelection()
    const range = sel ?? {
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    }
    const charBefore =
      range.startColumn > 1
        ? model.getValueInRange({
            startLineNumber: range.startLineNumber,
            startColumn: range.startColumn - 1,
            endLineNumber: range.startLineNumber,
            endColumn: range.startColumn
          })
        : ''
    const charAfter = model.getValueInRange({
      startLineNumber: range.endLineNumber,
      startColumn: range.endColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn + 1
    })
    const padded =
      (charBefore && !/\s/.test(charBefore) ? ' ' : '') + text + (/^\s/.test(charAfter) ? '' : ' ')
    editor.executeEdits('file-drop', [{ range, text: padded, forceMoveMarkers: true }])
    editor.focus()
  }

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    // insert dropped attachments at the cursor: images become compact [imageN]
    // chips (mapped to their real path for submit), other files their @-mention.
    insertAttachments: (items: Attachment[]) => {
      const tokens = items.map((it) => {
        if (!it.isImage) return it.mention
        const label = `[image${++imageCounterRef.current}]`
        imageMapRef.current.set(label, it.mention)
        return label
      })
      insertTokenText(tokens.join(' '))
    },
    fillIfEmpty: (text: string) => {
      const editor = editorRef.current
      if (!editor || editor.getValue().trim() !== '') return
      editor.setValue(text)
      const model = editor.getModel()
      if (model) {
        const line = model.getLineCount()
        editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) })
      }
    }
  }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const monaco = setupMonaco()

    // restore any draft parked when we last switched away from this tab (or, if
    // it came from session.json, when the app last quit)
    const initialDraft = draftFor(tabId)?.text ?? ''
    const model = monaco.editor.createModel(initialDraft, PROMPT_LANG, modelUriForTab(tabId))
    const editor = monaco.editor.create(host, {
      model,
      theme: 'claude-term',
      lineNumbers: 'off',
      minimap: { enabled: false },
      glyphMargin: false,
      folding: false,
      wordWrap: 'on',
      wrappingIndent: 'none',
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 12.5,
      lineHeight: 18,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { vertical: 'auto', horizontal: 'hidden', verticalScrollbarSize: 8 },
      padding: { top: 8, bottom: 8 },
      automaticLayout: true,
      // our wordPattern makes / and @ word characters, which routes them to the
      // quick-suggest path instead of trigger-characters — so quick suggest must
      // be on; the provider returns [] for plain prose so no noise appears
      quickSuggestions: { other: true, comments: false, strings: false },
      quickSuggestionsDelay: 10,
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'off',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      contextmenu: false,
      guides: { indentation: false },
      unicodeHighlight: { ambiguousCharacters: false },
      suggest: { showWords: false, preview: false },
      tabCompletion: 'off',
      // the input sits at the bottom of the window inside an overflow:hidden
      // wrapper — render the suggest widget in a fixed overlay so it can open
      // upward without being clipped
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    // keep the placeholder in sync with a restored draft, and drop the cursor at
    // its end so typing continues where it left off
    setEmpty(initialDraft === '')
    if (initialDraft) {
      const line = model.getLineCount()
      editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) })
    }
    // exposed for scripted E2E testing (CDP) — harmless at runtime
    const registry = ((window as unknown as Record<string, unknown>).__promptEditors ??=
      {}) as Record<TabId, monacoNs.editor.IStandaloneCodeEditor>
    registry[tabId] = editor

    // set the whole prompt text and park the cursor at the very end (history recall)
    const setValueCursorEnd = (text: string): void => {
      editor.setValue(text)
      const line = model.getLineCount()
      editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) })
      editor.revealLine(line)
    }

    // Terminal focus is always a loan: hand it over (or stand by to), then take
    // it back the moment the TUI stops showing something worth driving. Only one
    // loan runs at a time.
    const lendFocus = (mode: LoanMode): void => {
      loanCancelRef.current?.()
      loanCancelRef.current = runFocusLoan(mode, {
        probe: () => ({
          boxFocused: editor.hasTextFocus(),
          dialogOpen: terminalDialogOpen(tabId)
        }),
        focusBox: () => editor.focus(),
        focusTerminal: () => focusTerm(tabId)
      })
    }

    const send = (): void => {
      const text = editor.getValue().replace(/\n+$/, '')
      if (!text || editor.getOption(monaco.editor.EditorOption.readOnly)) return
      pushPrompt(tabId, text)
      historyIndexRef.current = null
      draftRef.current = ''
      // app-local command (e.g. /color, /switch): handle in-app, don't send to
      // claude. run() returns false to keep the box text (so a failed /switch
      // stays editable next to its error).
      const matched = matchAppCommand(text)
      if (matched) {
        void Promise.resolve(
          matched.cmd.run({
            tabId,
            arg: matched.arg,
            setColor: (c) => colorRef.current(c),
            setError: (m) => showCmdErrorRef.current(m)
          })
        ).then((keep) => {
          if (keep !== false) {
            editor.setValue('')
            editor.focus() // the Send button may have taken focus on the way in
          }
        })
        return
      }
      window.claudeTerm.submitPrompt(tabId, expandImages(text), countImages(text))
      editor.setValue('')
      resetImages()
      // A slash command opens a TUI menu only if it runs now; queued mid-turn it
      // opens nothing yet. focusAfterSubmit picks which — and 'box' also brings
      // focus back from the Send button.
      switch (focusAfterSubmit(text, focusStateRef.current)) {
        case 'lend-terminal':
          focusTerm(tabId)
          lendFocus('handover')
          break
        case 'watch-terminal':
          editor.focus()
          lendFocus('watch')
          break
        default:
          loanCancelRef.current?.()
          loanCancelRef.current = null
          editor.focus()
      }
    }
    sendRef.current = send

    // box just appeared for an active, dialog-free session → focus it now. Done
    // here (not via a ref call from App) so it lands after the editor exists,
    // sidestepping the mount/rAF race that left the box unfocused.
    if (autoFocusRef.current) editor.focus()

    // Enter must be intercepted at the keydown layer: addCommand(Enter) is
    // swallowed by Monaco's text-input (EditContext) pipeline, which inserts a
    // newline before a command keybinding can fire. onKeyDown + preventDefault
    // wins. While the suggest widget is open with a pick, let Monaco handle
    // Enter (accept) — but not in its Loading/No-suggestions message states,
    // where Enter has nothing to accept and must still submit.
    // The widget renders in a fixed overlay (fixedOverflowWidgets), so query it
    // at the document level; only the focused editor ever shows one.
    editor.onKeyDown((e) => {
      if (
        e.keyCode === monaco.KeyCode.Enter &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        if (suggestWidgetAccepting()) {
          // Enter = pick + run for single-select arg popups (e.g. /switch,
          // /model, /effort): accept the highlighted item, then submit. Tab
          // still just fills (Monaco's default accept, untouched). Dir pickers
          // (/add-dir) and plain /name, @file picks keep accept-only on Enter.
          if (picksAndRuns(model.getLineContent(1))) {
            e.preventDefault()
            e.stopPropagation()
            editor.trigger('kb', 'acceptSelectedSuggestion', {})
            queueMicrotask(() => send())
          }
          return
        }
        e.preventDefault()
        e.stopPropagation()
        send()
        return
      }
      // treat an [imageN] chip as one atom: backspace when the cursor sits just
      // after it, delete when just before it (or inside, either key) removes the
      // whole chip in one stroke instead of a character at a time
      const backspace = e.keyCode === monaco.KeyCode.Backspace
      const del = e.keyCode === monaco.KeyCode.Delete
      if ((backspace || del) && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const sel = editor.getSelection()
        const pos = editor.getPosition()
        if (!sel || !sel.isEmpty() || !pos) return
        const line = model.getLineContent(pos.lineNumber)
        for (const m of line.matchAll(IMAGE_TOKEN_RE)) {
          const start = (m.index ?? 0) + 1 // 1-based column of the chip's first char
          const stop = start + m[0].length // column just past the chip
          const inside = pos.column > start && pos.column < stop
          const hit = inside || (backspace ? pos.column === stop : pos.column === start)
          if (!hit) continue
          e.preventDefault()
          e.stopPropagation()
          editor.executeEdits('image-chip-delete', [
            {
              range: {
                startLineNumber: pos.lineNumber,
                startColumn: start,
                endLineNumber: pos.lineNumber,
                endColumn: stop
              },
              text: '',
              forceMoveMarkers: true
            }
          ])
          imageMapRef.current.delete(m[0])
          return
        }
      }
      // terminal-style prompt history: ↑ on the top visual line recalls older
      // prompts, ↓ on the bottom visual line walks forward again. The draft
      // being typed is parked on the first ↑ and restored when travelling past
      // the newest entry. Arrows anywhere else keep normal cursor movement,
      // and a wrapped long line is traversed row by row before history kicks in.
      const upKey = e.keyCode === monaco.KeyCode.UpArrow
      const downKey = e.keyCode === monaco.KeyCode.DownArrow
      if ((upKey || downKey) && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (suggestWidgetAccepting()) return
        const pos = editor.getPosition()
        const sel = editor.getSelection()
        if (!pos || (sel && !sel.isEmpty())) return
        const history = promptHistoryFor(tabId)
        // same rendered row ⇔ same top offset (handles wrap: model line 1 can
        // span several visual rows, only the outermost one triggers history)
        const rowTop = (p: monacoNs.IPosition): number =>
          editor.getScrolledVisiblePosition(p)?.top ?? NaN
        if (upKey) {
          const idx = historyIndexRef.current
          const nextIdx = idx === null ? history.length - 1 : idx - 1
          if (nextIdx < 0) return
          if (pos.lineNumber !== 1 || rowTop(pos) !== rowTop({ lineNumber: 1, column: 1 })) return
          e.preventDefault()
          e.stopPropagation()
          if (idx === null) draftRef.current = editor.getValue()
          historyIndexRef.current = nextIdx
          setValueCursorEnd(history[nextIdx])
        } else {
          if (historyIndexRef.current === null) return
          const lastLine = model.getLineCount()
          const end = { lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }
          if (pos.lineNumber !== lastLine || rowTop(pos) !== rowTop(end)) return
          e.preventDefault()
          e.stopPropagation()
          const nextIdx = historyIndexRef.current + 1
          if (nextIdx >= history.length) {
            historyIndexRef.current = null
            setValueCursorEnd(draftRef.current)
          } else {
            historyIndexRef.current = nextIdx
            setValueCursorEnd(history[nextIdx])
          }
        }
        return
      }
      // Tab in an empty box runs Claude Code's suggested next prompt where it
      // lives — the TUI input line: forward Tab (accept the suggestion) and,
      // a beat later, Enter (submit it) to the PTY. The PTY doesn't need DOM
      // focus, so the box keeps it — the terminal only takes focus if the turn
      // needs input (App's needs-attention handling). Only fires when the TUI
      // is actually showing a suggestion; otherwise Tab keeps its default.
      if (
        e.keyCode === monaco.KeyCode.Tab &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        editor.getValue() === '' &&
        !editor.getOption(monaco.editor.EditorOption.readOnly) &&
        !suggestWidgetAccepting() &&
        readInputSuggestion(tabId)
      ) {
        e.preventDefault()
        e.stopPropagation()
        window.claudeTerm.ptyInput(tabId, '\t')
        // let the TUI ingest the accepted text before the submitting Enter
        window.setTimeout(() => window.claudeTerm.ptyInput(tabId, '\r'), 150)
        return
      }
      // ← in an empty box opens Claude Code's agents overview: forward the key
      // to the PTY and hand focus to the terminal to navigate it. The watcher
      // brings focus back here as soon as the view is left.
      if (
        e.keyCode === monaco.KeyCode.LeftArrow &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        editor.getValue() === '' &&
        !editor.getOption(monaco.editor.EditorOption.readOnly)
      ) {
        e.preventDefault()
        e.stopPropagation()
        window.claudeTerm.ptyInput(tabId, '\x1b[D')
        focusTerm(tabId)
        lendFocus('handover')
      }
    })
    editor.addCommand(monaco.KeyCode.Escape, () => focusTerm(tabId), '!suggestWidgetVisible')
    editor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyCode.Tab,
      () => window.claudeTerm.ptyInput(tabId, '\x1b[Z'),
      '!suggestWidgetVisible'
    )
    // ⌘[ / ⌘] step tabs even from the box (Monaco owns these for out/indent,
    // so the window-level handler never sees them — override here). ⌘←/⌘→ are
    // left to Monaco for line-start/end.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketLeft, () =>
      stepTabRef.current(-1)
    )
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketRight, () =>
      stepTabRef.current(1)
    )
    // ⌘K / ⌘F are Monaco commands (chord prefix, find widget) — rebind them to
    // the app's palette and the terminal's scrollback search.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openPaletteRef.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () =>
      findInTerminalRef.current()
    )
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => openMissionRef.current())
    // ⌘/ is Monaco's toggle-comment — rebind to the Quick How-To overlay
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => showHelpRef.current())

    // Monaco never auto-triggers suggest on deletions (its quick-suggest path
    // only fires when the cursor moves right). Re-open the popup ourselves
    // when backspacing inside a /command or @file token.
    const retriggerSub = editor.onDidChangeModelContent((e) => {
      if (!e.changes.some((c) => c.text === '')) return
      setTimeout(() => {
        const pos = editor.getPosition()
        const currentModel = editor.getModel()
        if (!pos || !currentModel || !editor.hasTextFocus()) return
        const before = currentModel.getLineContent(pos.lineNumber).slice(0, pos.column - 1)
        const inSlash = pos.lineNumber === 1 && before.startsWith('/') && !/\s/.test(before)
        const inAt = /(^|\s)@[^\s@]*$/.test(before)
        // deleting inside a command's arg (e.g. "/switch fea", "/add-dir sr") reopens its picker
        const argCmd = /^\/(\S+)\s/.exec(before)
        const inAppArg = pos.lineNumber === 1 && !!argCmd && !!getArgCompleter(argCmd[1])
        if (inSlash || inAt || inAppArg)
          editor.trigger('deleteRetrigger', 'editor.action.triggerSuggest', {})
      }, 0)
    })

    const grow = (): void => {
      const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, editor.getContentHeight()))
      host.style.height = `${height}px`
    }
    const contentSub = editor.onDidContentSizeChange(grow)
    // Keep the parked draft current as it's typed, not just on unmount: the
    // active tab's box never unmounts, so at quit its text would otherwise never
    // have reached the store. This only updates the in-memory store — it
    // deliberately doesn't trigger a session save, or every keystroke would churn
    // session.json and flood session-backups/ with draft noise.
    const changeSub = editor.onDidChangeModelContent(() => {
      const text = model.getValue()
      setEmpty(text === '')
      saveDraft(tabId, text, imageMapRef.current)
    })
    const spell = attachSpellcheck(editor, 'prompt')
    grow()

    return () => {
      // park the unsubmitted draft (if any) so it's restored on remount, with the
      // image chips it refers to; a blank box drops the entry so a stale draft
      // can't resurrect
      saveDraft(tabId, editor.getValue(), imageMapRef.current)
      loanCancelRef.current?.()
      loanCancelRef.current = null
      if (cmdErrorTimer.current !== null) window.clearTimeout(cmdErrorTimer.current)
      contentSub.dispose()
      changeSub.dispose()
      retriggerSub.dispose()
      spell.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
      delete registry[tabId]
    }
  }, [tabId])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: disabled })
  }, [disabled])

  return (
    <div
      className={`prompt-box ${disabled ? 'disabled' : ''}`}
      style={color ? { borderTopColor: color } : undefined}
    >
      <div
        className="editor-wrap"
        style={color ? ({ '--session-color': color } as React.CSSProperties) : undefined}
      >
        <div className="editor-host" ref={hostRef} />
        <SpellToggle />
        {cmdError && <div className="editor-cmd-error">{cmdError}</div>}
        {empty && (
          <div className="editor-placeholder">
            {disabled
              ? 'session ended'
              : 'Prompt — Enter to send, Shift+Enter newline, / commands, @ files, ↑ history, ← agents, Tab runs suggestion, Esc to terminal (⌘L here), ⌘/ cheat sheet'}
          </div>
        )}
      </div>
      <button className="send-btn" disabled={disabled || empty} onClick={() => sendRef.current()}>
        Send
      </button>
    </div>
  )
})
