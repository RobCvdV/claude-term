// Import the editor API namespace + all editor *features* (suggest widget,
// word operations, bracket matching, clipboard, …) but NONE of Monaco's ~90
// bundled languages or its TS/JSON/CSS/HTML language services — we only ever
// register our own empty `claude-prompt` language, so those are dead weight.
// (The full `monaco-editor` entry = editor.all + all of that.)
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
// The one bundled language we opt into: markdown, for the docs editor's syntax
// highlighting. (Self-registers the 'markdown' language on import.)
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { TabId } from '../../shared/types'

self.MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

export const PROMPT_LANG = 'claude-prompt'
export const MARKDOWN_LANG = 'markdown'

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

  return monaco
}

function tabIdFromModel(model: monaco.editor.ITextModel): TabId | null {
  const uri = model.uri.toString()
  return uri.startsWith('claude-term://tab/') ? uri.slice('claude-term://tab/'.length) : null
}

export function modelUriForTab(tabId: TabId): monaco.Uri {
  return monaco.Uri.parse(`claude-term://tab/${tabId}`)
}
