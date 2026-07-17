import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { TabId } from '../../../shared/types'
import { focusTerm } from '../term-registry'
import { setupMonaco, modelUriForTab, PROMPT_LANG } from '../monaco-setup'

const MIN_HEIGHT = 64
const MAX_HEIGHT = 240

interface Props {
  tabId: TabId
  disabled: boolean
  onStepTab: (delta: number) => void
  onColor: (color: string) => void
  color?: string
}

// app-local command: "/color blue" (or #rrggbb, or off) tints the tab border
// without ever reaching claude. Returns the color arg, or null if not a match.
const COLOR_RE = /^\/color\s+(\S+)\s*$/i
function parseColor(text: string): string | null {
  return text.match(COLOR_RE)?.[1]?.toLowerCase() ?? null
}

export interface PromptBoxHandle {
  focus: () => void
}

export const PromptBox = forwardRef<PromptBoxHandle, Props>(function PromptBox(
  { tabId, disabled, onStepTab, onColor, color },
  ref
): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
  const [empty, setEmpty] = useState(true)
  // keep the latest handlers for the addCommand/closure below (bound once)
  const stepTabRef = useRef(onStepTab)
  stepTabRef.current = onStepTab
  const colorRef = useRef(onColor)
  colorRef.current = onColor

  useImperativeHandle(ref, () => ({ focus: () => editorRef.current?.focus() }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const monaco = setupMonaco()

    const model = monaco.editor.createModel('', PROMPT_LANG, modelUriForTab(tabId))
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
    // exposed for scripted E2E testing (CDP) — harmless at runtime
    const registry = ((window as unknown as Record<string, unknown>).__promptEditors ??=
      {}) as Record<TabId, monacoNs.editor.IStandaloneCodeEditor>
    registry[tabId] = editor

    const send = (): void => {
      const text = editor.getValue().replace(/\n+$/, '')
      if (!text || editor.getOption(monaco.editor.EditorOption.readOnly)) return
      const color = parseColor(text)
      if (color) {
        colorRef.current(color)
        editor.setValue('')
        return
      }
      window.claudeTerm.submitPrompt(tabId, text)
      editor.setValue('')
      // slash commands usually open a TUI menu/dialog — hand focus to the
      // terminal so arrows/Enter drive it right away
      if (text.startsWith('/')) focusTerm(tabId)
    }

    // Enter must be intercepted at the keydown layer: addCommand(Enter) is
    // swallowed by Monaco's text-input (EditContext) pipeline, which inserts a
    // newline before a command keybinding can fire. onKeyDown + preventDefault
    // wins. While the suggest widget is open, let Monaco handle Enter (accept).
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
        if (document.querySelector('.suggest-widget.visible')) return
        e.preventDefault()
        e.stopPropagation()
        send()
      }
    })
    editor.addCommand(
      monaco.KeyCode.Escape,
      () => focusTerm(tabId),
      '!suggestWidgetVisible'
    )
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
        if (inSlash || inAt) editor.trigger('deleteRetrigger', 'editor.action.triggerSuggest', {})
      }, 0)
    })

    const grow = (): void => {
      const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, editor.getContentHeight()))
      host.style.height = `${height}px`
    }
    const contentSub = editor.onDidContentSizeChange(grow)
    const changeSub = editor.onDidChangeModelContent(() => setEmpty(model.getValue() === ''))
    grow()

    return () => {
      contentSub.dispose()
      changeSub.dispose()
      retriggerSub.dispose()
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
        {empty && (
          <div className="editor-placeholder">
            {disabled
              ? 'session ended'
              : 'Prompt — Enter to send, Shift+Enter newline, / commands, @ files, Esc to terminal (⌘K here)'}
          </div>
        )}
      </div>
      <button
        className="send-btn"
        disabled={disabled || empty}
        onClick={() => {
          const editor = editorRef.current
          if (!editor) return
          const text = editor.getValue().replace(/\n+$/, '')
          if (!text) return
          const color = parseColor(text)
          if (color) {
            onColor(color)
            editor.setValue('')
            return
          }
          window.claudeTerm.submitPrompt(tabId, text)
          editor.setValue('')
          if (text.startsWith('/')) focusTerm(tabId)
        }}
      >
        Send
      </button>
    </div>
  )
})
