import type * as monacoNs from 'monaco-editor'
import { setupMonaco } from './monaco-setup'
import { attachClaudeEdit } from './claude-edit'

/**
 * "✨ Complete with Claude" in a file window: the top entry of the ⌃Space
 * suggestion list. Picking it asks Claude (on the user's own login) for the
 * text at the cursor and shows that as an inline suggestion — Tab takes it,
 * Esc or typing drops it. Only editors attached here get the entry; the
 * prompt box shares Monaco but not this.
 */

const COMMAND = 'claude-term.completeWithClaude'
const TITLE = '✨ Complete with Claude'

interface Attached {
  editor: monacoNs.editor.IStandaloneCodeEditor
  path: string
}

interface Pending {
  uri: string
  line: number
  column: number
  /** model version the suggestion was made for — any edit makes it stale */
  version: number
  text: string
}

const attached = new Map<string, Attached>()
let pending: Pending | null = null
let registered = false

function register(monaco: typeof monacoNs): void {
  if (registered) return
  registered = true
  monaco.editor.addCommand({
    id: COMMAND,
    run: (_accessor, uri: string) => {
      const target = attached.get(uri)
      if (target) void request(target)
    }
  })
  monaco.languages.registerCompletionItemProvider('*', {
    provideCompletionItems: (model, position, context) => {
      const uri = model.uri.toString()
      // only on ⌃Space, not while typing triggers the list
      if (
        !attached.has(uri) ||
        context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke
      ) {
        return { suggestions: [] }
      }
      // Monaco ranks items by how well they match the word typed so far, so the
      // entry covers that word and puts it back unchanged — an empty range would
      // match nothing and sink below every word suggestion
      const word = model.getWordUntilPosition(position)
      const at = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }
      return {
        suggestions: [
          {
            label: TITLE,
            kind: monaco.languages.CompletionItemKind.Event,
            detail: 'Haiku · Tab accepts',
            filterText: word.word,
            sortText: '\u0000',
            preselect: true,
            insertText: word.word,
            range: at,
            command: { id: COMMAND, title: TITLE, arguments: [uri] }
          }
        ]
      }
    }
  })
  monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions: (model, position) => {
      const p = pending
      if (
        !p ||
        p.uri !== model.uri.toString() ||
        p.version !== model.getVersionId() ||
        p.line !== position.lineNumber ||
        p.column !== position.column
      ) {
        return { items: [] }
      }
      // a multi-line insert must replace up to the line's end, so carry the
      // rest of the line along behind the completion
      const lineEnd = model.getLineMaxColumn(position.lineNumber)
      const rest = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: lineEnd
      })
      return {
        items: [
          {
            insertText: p.text + rest,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: lineEnd
            }
          }
        ]
      }
    },
    disposeInlineCompletions: () => {}
  })
}

/** A small note at the cursor while Claude works, or when it fails. */
function showNote(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  position: monacoNs.IPosition,
  text: string,
  error = false
): () => void {
  const node = document.createElement('div')
  node.className = `claude-complete-note${error ? ' claude-complete-error' : ''}`
  node.textContent = text
  const widget: monacoNs.editor.IContentWidget = {
    getId: () => 'claude-complete-note',
    getDomNode: () => node,
    getPosition: () => ({ position, preference: [1, 2] })
  }
  editor.addContentWidget(widget)
  return () => editor.removeContentWidget(widget)
}

async function request({ editor, path }: Attached): Promise<void> {
  const model = editor.getModel()
  const position = editor.getPosition()
  if (!model || !position) return
  const full = model.getFullModelRange()
  const prefix = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  })
  const suffix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: full.endLineNumber,
    endColumn: full.endColumn
  })
  const version = model.getVersionId()
  const hide = showNote(editor, position, '✨ Asking Claude…')
  const res = await window.claudeTerm.claudeComplete({ path, prefix, suffix })
  hide()
  if (!res.ok) {
    const hideError = showNote(editor, position, `Claude: ${res.error}`, true)
    setTimeout(hideError, 4_000)
    return
  }
  // typed on meanwhile, or nothing to add: drop it quietly
  if (!res.text || model.isDisposed() || model.getVersionId() !== version) return
  pending = {
    uri: model.uri.toString(),
    line: position.lineNumber,
    column: position.column,
    version,
    text: res.text
  }
  editor.setPosition(position)
  editor.focus()
  editor.trigger('claude-term', 'editor.action.inlineSuggest.trigger', {})
}

/** Give a file-window editor the ⌃Space "Complete with Claude" entry. */
export function attachClaudeCompletion(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  path: string
): monacoNs.IDisposable {
  const monaco = setupMonaco()
  register(monaco)
  const uri = editor.getModel()?.uri.toString()
  if (!uri) return { dispose: () => {} }
  attached.set(uri, { editor, path })
  window.claudeTerm.claudeWarm('complete', path)
  attachClaudeEdit(editor, path)
  return {
    dispose: () => {
      attached.delete(uri)
      if (pending?.uri === uri) pending = null
    }
  }
}
