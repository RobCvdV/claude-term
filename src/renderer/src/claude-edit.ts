import type * as monacoNs from 'monaco-editor'
import { setupMonaco } from './monaco-setup'

/**
 * "Edit selection with Claude" in a file window: ⌃Space with text selected
 * opens a one-line prompt above the selection; Claude's replacement comes back
 * as a diff over the editor — ⌘Enter applies it, Esc drops it, and the prompt
 * can be reopened to try another instruction.
 */

type Editor = monacoNs.editor.IStandaloneCodeEditor

interface EditSession {
  range: monacoNs.IRange
  original: string
  instruction: string
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}

/** The open prompt per editor — a second ⌃Space replaces it, never stacks. */
const openPrompts = new WeakMap<Editor, () => void>()

/** The one-line instruction input, as a content widget above the selection. */
function openPrompt(editor: Editor, path: string, session: EditSession): void {
  openPrompts.get(editor)?.()
  const box = el('div', 'claude-edit-prompt')
  const label = el('div', 'claude-edit-label', '✨ Edit selection with Claude')
  const input = el('input', 'claude-edit-input')
  input.placeholder = 'Describe the change — Enter to send, Esc to cancel'
  input.value = session.instruction
  const note = el('div', 'claude-edit-note')
  box.append(label, input, note)
  const widget: monacoNs.editor.IContentWidget = {
    getId: () => 'claude-edit-prompt',
    getDomNode: () => box,
    getPosition: () => ({
      position: { lineNumber: session.range.startLineNumber, column: 1 },
      preference: [1, 2]
    }),
    allowEditorOverflow: true
  }
  let busy = false
  const close = (): void => {
    if (openPrompts.get(editor) !== close) return
    openPrompts.delete(editor)
    moved.dispose()
    editor.removeContentWidget(widget)
    editor.focus()
  }
  // clicking or moving elsewhere means the prompt is no longer wanted
  const moved = editor.onDidChangeCursorSelection(() => {
    if (!busy) close()
  })
  openPrompts.set(editor, close)
  input.addEventListener('keydown', (e) => {
    // keep Monaco's own keybindings out of the input
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault()
      session.instruction = input.value.trim()
      busy = true
      void send(editor, path, session, input, note, close).finally(() => (busy = false))
    }
  })
  editor.addContentWidget(widget)
  window.claudeTerm.claudeWarm('edit', path)
  setTimeout(() => input.focus(), 0)
}

async function send(
  editor: Editor,
  path: string,
  session: EditSession,
  input: HTMLInputElement,
  note: HTMLElement,
  close: () => void
): Promise<void> {
  const model = editor.getModel()
  if (!model) return
  const full = model.getFullModelRange()
  const { range } = session
  const before = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: range.startLineNumber,
    endColumn: range.startColumn
  })
  const after = model.getValueInRange({
    startLineNumber: range.endLineNumber,
    startColumn: range.endColumn,
    endLineNumber: full.endLineNumber,
    endColumn: full.endColumn
  })
  input.disabled = true
  note.className = 'claude-edit-note'
  note.textContent = '✨ Claude is editing…'
  const res = await window.claudeTerm.claudeEdit({
    path,
    before,
    selection: session.original,
    after,
    instruction: session.instruction
  })
  if (!res.ok) {
    input.disabled = false
    note.className = 'claude-edit-note claude-edit-error'
    note.textContent = `Claude: ${res.error}`
    input.focus()
    return
  }
  close()
  showDiff(editor, path, session, res.text)
}

/** Claude's replacement as an inline diff over the lower part of the editor. */
function showDiff(editor: Editor, path: string, session: EditSession, text: string): void {
  const monaco = setupMonaco()
  const model = editor.getModel()
  const container = editor.getContainerDomNode()
  if (!model) return
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'

  const panel = el('div', 'claude-edit-diff')
  const head = el('div', 'claude-edit-head')
  const title = el('span', 'claude-edit-title', `✨ ${session.instruction}`)
  const accept = el('button', 'docs-btn', 'Apply ⌘↵')
  const retry = el('button', 'docs-btn', 'Change instruction')
  const reject = el('button', 'docs-btn', 'Discard Esc')
  const message = el('span', 'claude-edit-error')
  head.append(title, message, accept, retry, reject)
  const host = el('div', 'claude-edit-host')
  panel.append(head, host)
  container.append(panel)

  const language = model.getLanguageId()
  const original = monaco.editor.createModel(session.original, language)
  const modified = monaco.editor.createModel(text, language)
  const diff = monaco.editor.createDiffEditor(host, {
    renderSideBySide: false,
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    theme: 'claude-term'
  })
  diff.setModel({ original, modified })

  const done = (): void => {
    panel.removeEventListener('keydown', onKey, true)
    diff.dispose()
    original.dispose()
    modified.dispose()
    panel.remove()
    editor.focus()
  }
  const apply = (): void => {
    // only onto the text Claude saw — an edit meanwhile would be overwritten
    if (model.getValueInRange(session.range) !== session.original) {
      message.textContent = 'The selection changed meanwhile — not applied'
      return
    }
    const start = model.getOffsetAt({
      lineNumber: session.range.startLineNumber,
      column: session.range.startColumn
    })
    editor.executeEdits('claude-edit', [{ range: session.range, text, forceMoveMarkers: true }])
    editor.pushUndoStop()
    done()
    // a selection left over the new text would make the next ⌃Space an edit again
    editor.setPosition(model.getPositionAt(start + text.length))
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      done()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      apply()
    }
  }
  panel.tabIndex = -1
  panel.addEventListener('keydown', onKey, true)
  accept.addEventListener('click', apply)
  reject.addEventListener('click', done)
  retry.addEventListener('click', () => {
    done()
    editor.setSelection(session.range)
    openPrompt(editor, path, session)
  })
  setTimeout(() => panel.focus(), 0)
}

/** Bind ⌃Space-with-a-selection to the edit prompt in a file-window editor. */
export function attachClaudeEdit(editor: Editor, path: string): void {
  const monaco = setupMonaco()
  editor.addCommand(
    monaco.KeyMod.WinCtrl | monaco.KeyCode.Space,
    () => {
      const model = editor.getModel()
      const sel = editor.getSelection()
      if (!model || !sel || sel.isEmpty()) return
      openPrompt(editor, path, {
        range: {
          startLineNumber: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLineNumber: sel.endLineNumber,
          endColumn: sel.endColumn
        },
        original: model.getValueInRange(sel),
        instruction: ''
      })
    },
    // without a selection ⌃Space keeps opening the suggestion list
    'editorHasSelection'
  )
}
