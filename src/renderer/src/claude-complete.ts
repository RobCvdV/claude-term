import type * as monacoNs from 'monaco-editor'
import { setupMonaco } from './monaco-setup'
import { attachClaudeEdit } from './claude-edit'

/**
 * Claude in the ⌃Space suggestion list of a file-window editor. ⌃Space asks
 * Claude (on the user's own login) for the text at the cursor; its entry says
 * "thinking…" until the answer is in, then the list refreshes and the entry
 * shows that answer — Tab or Enter inserts it. Nothing is asked while typing,
 * and only editors attached here get the entry; the prompt box shares Monaco
 * but not this.
 */

interface Attached {
  editor: monacoNs.editor.IStandaloneCodeEditor
  path: string
}

/** The one request in flight or answered, for one cursor spot. */
interface Ask {
  /** uri + model version + position — any edit or cursor move makes it another spot */
  key: string
  state: 'busy' | 'done' | 'error'
  text?: string
  error?: string
}

const attached = new Map<string, Attached>()
let ask: Ask | null = null
let registered = false

/** Shortest line of the answer worth showing as the list entry. */
function labelFor(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? text
  const flat = first.trim()
  const more = text.trim().includes('\n') ? ' …' : ''
  return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat + more
}

function textAround(
  model: monacoNs.editor.ITextModel,
  position: monacoNs.Position
): { prefix: string; suffix: string } {
  const full = model.getFullModelRange()
  return {
    prefix: model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    }),
    suffix: model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: full.endLineNumber,
      endColumn: full.endColumn
    })
  }
}

/** Ask Claude for `key`'s spot; when the answer lands and the list is still
 *  open on that spot, reopen it so the entry shows the answer. */
function start(
  target: Attached,
  model: monacoNs.editor.ITextModel,
  position: monacoNs.Position,
  key: string
): void {
  ask = { key, state: 'busy' }
  const { prefix, suffix } = textAround(model, position)
  void window.claudeTerm.claudeComplete({ path: target.path, prefix, suffix }).then((res) => {
    if (ask?.key !== key) return
    ask = res.ok
      ? { key, state: res.text ? 'done' : 'error', text: res.text, error: 'nothing to add here' }
      : { key, state: 'error', error: res.error }
    const ed = target.editor
    const pos = ed.getPosition()
    const listOpen = !!ed.getDomNode()?.ownerDocument.querySelector('.suggest-widget.visible')
    if (
      listOpen &&
      !model.isDisposed() &&
      pos &&
      `${model.uri.toString()}|${model.getVersionId()}|${pos.lineNumber}|${pos.column}` === key
    ) {
      // reopening at the same spot would reuse the old results — close it first
      ed.trigger('claude-term', 'hideSuggestWidget', {})
      ed.trigger('claude-term', 'editor.action.triggerSuggest', {})
    }
  })
}

function register(monaco: typeof monacoNs): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('*', {
    provideCompletionItems: (model, position, context) => {
      const uri = model.uri.toString()
      const target = attached.get(uri)
      // only on ⌃Space, never while typing
      if (!target || context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) {
        return { suggestions: [] }
      }
      const key = `${uri}|${model.getVersionId()}|${position.lineNumber}|${position.column}`
      if (ask?.key !== key) start(target, model, position, key)
      // Monaco ranks items by how well they match the word typed so far, so the
      // entry covers that word — an empty range would sink below every word suggestion
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }
      const base = {
        kind: monaco.languages.CompletionItemKind.Event,
        filterText: word.word,
        sortText: '\u0000',
        preselect: true,
        range
      }
      const current = ask!
      if (current.state === 'done' && current.text) {
        return {
          suggestions: [
            {
              ...base,
              label: `✨ ${labelFor(current.text)}`,
              detail: 'Claude · Tab inserts',
              documentation: { value: '```\n' + current.text + '\n```' },
              insertText: word.word + current.text
            }
          ]
        }
      }
      return {
        // still coming: tell Monaco these results are not final
        incomplete: current.state === 'busy',
        suggestions: [
          {
            ...base,
            label:
              current.state === 'busy' ? '✨ Claude is thinking…' : `✨ Claude: ${current.error}`,
            detail: current.state === 'busy' ? 'the list refreshes when the answer is in' : '',
            // nothing to insert yet — taking it leaves the line as it is
            insertText: word.word
          }
        ]
      }
    }
  })
}

/** Give a file-window editor Claude in its ⌃Space list (and ⌃Space edits on a selection). */
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
      if (ask?.key.startsWith(`${uri}|`)) ask = null
    }
  }
}
