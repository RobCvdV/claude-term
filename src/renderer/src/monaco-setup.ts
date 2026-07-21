// Import the editor API namespace + all editor *features* (suggest widget,
// word operations, bracket matching, clipboard, …) but NONE of Monaco's ~90
// bundled languages or its TS/JSON/CSS/HTML language services — we only ever
// register our own empty `claude-prompt` language, so those are dead weight.
// (The full `monaco-editor` entry = editor.all + all of that.)
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { TabId } from '../../shared/types'

self.MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

export const PROMPT_LANG = 'claude-prompt'

// Claude Code's own "suggested next prompt" (scraped from the terminal, see
// term-registry.readInputSuggestion) mirrored per tab. The inline-completions
// provider below turns it into Monaco ghost text — Tab/→ accepts, typing that
// diverges from it dismisses. Keyed by tabId; language providers are global, so
// this shared map is how the single provider knows each editor's suggestion.
const inlineSuggestions = new Map<TabId, string>()

export function setInlineSuggestion(tabId: TabId, text: string): void {
  inlineSuggestions.set(tabId, text)
}
export function clearInlineSuggestion(tabId: TabId): void {
  inlineSuggestions.delete(tabId)
}

let initialized = false

export function setupMonaco(): typeof monaco {
  if (initialized) return monaco
  initialized = true
  // exposed for scripted E2E testing (CDP)
  ;(window as unknown as Record<string, unknown>).__monaco = monaco

  monaco.languages.register({ id: PROMPT_LANG })
  // words may contain path characters so @dir/file keeps filtering as one token
  monaco.languages.setLanguageConfiguration(PROMPT_LANG, {
    wordPattern: /[^\s]+/
  })

  monaco.editor.defineTheme('claude-term', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#2a2b30',
      'editor.foreground': '#d4d4d8',
      'editorCursor.foreground': '#d4d4d8',
      'editorSuggestWidget.background': '#232428',
      'editorSuggestWidget.border': '#35363c',
      'editorSuggestWidget.selectedBackground': '#3b3f46',
      'editorSuggestWidget.highlightForeground': '#d97757',
      'editor.lineHighlightBackground': '#2a2b30',
      'editorWidget.background': '#232428',
      'editorWidget.border': '#35363c',
      'scrollbarSlider.background': '#35363c88'
    }
  })

  monaco.languages.registerCompletionItemProvider(PROMPT_LANG, {
    triggerCharacters: ['/', '@'],
    provideCompletionItems: async (model, position) => {
      const tabId = tabIdFromModel(model)
      if (!tabId) return { suggestions: [] }
      const line = model.getLineContent(position.lineNumber)
      const before = line.slice(0, position.column - 1)

      // slash commands: only as the very first token of the message
      if (position.lineNumber === 1 && before.startsWith('/') && !/\s/.test(before)) {
        const commands = await window.claudeTerm.listCommands(tabId)
        const range = new monaco.Range(1, 1, 1, position.column)
        return {
          suggestions: commands.map((cmd) => ({
            label: { label: `/${cmd.name}`, description: cmd.source },
            kind: monaco.languages.CompletionItemKind.Function,
            detail: cmd.hint,
            documentation: cmd.description,
            insertText: `/${cmd.name} `,
            filterText: `/${cmd.name}`,
            range
          }))
        }
      }

      // @file mentions: token starting with @ anywhere in the text
      const atMatch = /(^|\s)(@([^\s@]*))$/.exec(before)
      if (atMatch) {
        const query = atMatch[3]
        const startColumn = position.column - atMatch[2].length
        const files = await window.claudeTerm.searchFiles(tabId, query)
        const range = new monaco.Range(
          position.lineNumber,
          startColumn,
          position.lineNumber,
          position.column
        )
        return {
          suggestions: files.map((path, i) => {
            const isDir = path.endsWith('/')
            return {
              label: path,
              kind: isDir
                ? monaco.languages.CompletionItemKind.Folder
                : monaco.languages.CompletionItemKind.File,
              // dirs: no trailing space + reopen the popup to descend a level
              insertText: `@${path}${isDir ? '' : ' '}`,
              filterText: `@${path}`,
              sortText: String(i).padStart(4, '0'),
              range,
              command: isDir ? { id: 'editor.action.triggerSuggest', title: 'descend' } : undefined
            }
          }),
          // the backend returns only the top matches for this query — force a
          // re-query on every keystroke (narrowing AND widening/backspace)
          // instead of letting monaco filter the truncated list locally
          incomplete: true
        }
      }

      return { suggestions: [] }
    }
  })

  // Ghost text for Claude Code's suggested next prompt. Only offered while the
  // typed text is still a prefix of the suggestion (single line) — so it shows
  // in an empty box and keeps offering the remainder as you type along it, and
  // silently vanishes the moment you type something different. Tab/→ commits it
  // via Monaco's built-in inline-suggest keybindings.
  monaco.languages.registerInlineCompletionsProvider(PROMPT_LANG, {
    provideInlineCompletions: (model, position) => {
      const tabId = tabIdFromModel(model)
      if (!tabId) return { items: [] }
      const suggestion = inlineSuggestions.get(tabId)
      if (!suggestion) return { items: [] }
      // single-line prompts only: the suggestion Claude Code renders is one line
      if (model.getLineCount() > 1) return { items: [] }
      const typed = model.getValue()
      if (typed.length >= suggestion.length || !suggestion.startsWith(typed)) return { items: [] }
      return {
        items: [
          {
            insertText: suggestion,
            range: new monaco.Range(1, 1, position.lineNumber, position.column)
          }
        ]
      }
    },
    disposeInlineCompletions: () => {}
  })

  // isolation test hook (CDP/DevTools): force a suggestion onto a tab's box to
  // verify the Monaco ghost-text side independent of the terminal scrape.
  ;(window as unknown as Record<string, unknown>).__setInlineSuggestion = (
    tabId: TabId,
    text: string
  ): void => {
    setInlineSuggestion(tabId, text)
    const editors = (window as unknown as Record<string, unknown>).__promptEditors as
      | Record<string, monaco.editor.IStandaloneCodeEditor>
      | undefined
    const editor = editors?.[tabId]
    if (editor) {
      editor.focus()
      editor.trigger('test', 'editor.action.inlineSuggest.trigger', {})
    }
  }

  return monaco
}

function tabIdFromModel(model: monaco.editor.ITextModel): TabId | null {
  const uri = model.uri.toString()
  return uri.startsWith('claude-term://tab/') ? uri.slice('claude-term://tab/'.length) : null
}

export function modelUriForTab(tabId: TabId): monaco.Uri {
  return monaco.Uri.parse(`claude-term://tab/${tabId}`)
}
