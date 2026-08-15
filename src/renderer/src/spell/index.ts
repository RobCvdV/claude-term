// Spell checking for the app's Monaco editors: misspellings become Info markers
// (a subtle squiggle) with quick fixes for the suggestions and an "add to
// dictionary" escape hatch for our own jargon.
import * as monaco from 'monaco-editor/editor/editor.api'
import SpellWorker from './spell.worker?worker'
import { extractWords, type SpellMode, type WordHit } from './words'
import { TECH_WORDS } from './tech-words'
import { SPELL_LANGS, type SpellLang, type WorkerRequest, type WorkerResponse } from './protocol'

export type { SpellLang, SpellMode }
export { SPELL_LANGS }

const MARKER_OWNER = 'spell'
const MARKER_SOURCE = 'spell'
const ADD_COMMAND = 'claudeTerm.spell.add'
const DEBOUNCE_MS = 350
const MAX_SUGGESTIONS = 6
const CACHE_MAX = 20000

export interface SpellConfig {
  /** master switch (`/spell off`) — covers spelling AND grammar */
  enabled: boolean
  /** dictionaries to check against; empty means no spell checking */
  langs: SpellLang[]
  /** grammar checking in the docs editor (see ../grammar) */
  grammar: boolean
}

const CONFIG_KEY = 'claudeTerm.spell.config'
const WORDS_KEY = 'claudeTerm.spell.words'

function loadConfig(): SpellConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<SpellConfig>
      if (Array.isArray(p.langs)) {
        return {
          enabled: p.enabled !== false,
          langs: p.langs.filter((l): l is SpellLang => SPELL_LANGS.includes(l)),
          grammar: p.grammar !== false
        }
      }
    }
  } catch {
    /* fall through to the default */
  }
  // English with a bit of Dutch mixed in is the normal case here, so both are on
  return { enabled: true, langs: ['en', 'nl'], grammar: true }
}

function loadPersonal(): Set<string> {
  try {
    const raw = localStorage.getItem(WORDS_KEY)
    const words = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(words.map((w) => w.toLowerCase()))
  } catch {
    return new Set()
  }
}

let config = loadConfig()
const personal = loadPersonal()

export function getSpellConfig(): SpellConfig {
  return { enabled: config.enabled, langs: [...config.langs], grammar: config.grammar }
}

/** One-liner for the `/spell` command's menu ("on — en+nl"). */
export function describeSpellConfig(): string {
  if (!config.enabled) return 'off'
  return config.langs.length ? `on — ${config.langs.join('+')}` : 'words off'
}

const listeners = new Set<() => void>()

/**
 * Run `listener` whenever the config changes — here or in the other window. The
 * prompt box's EN/NL chip, the `/spell` command and the docs window all write
 * the same setting, so they all have to hear about each other's edits.
 */
export function onSpellConfigChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(): void {
  for (const listener of listeners) listener()
}

export function setSpellConfig(next: SpellConfig): void {
  config = { enabled: next.enabled, langs: [...next.langs], grammar: next.grammar }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* a lost preference is not worth failing the command over */
  }
  applyConfig()
}

function applyConfig(): void {
  verdicts.clear()
  worker?.postMessage({ type: 'config', langs: config.langs } satisfies WorkerRequest)
  refreshAll()
  announce()
}

// The main window and the docs window are separate documents on one origin, so
// localStorage `storage` events are how a `/spell` (or chip) change in one
// reaches the other.
window.addEventListener('storage', (e) => {
  if (e.key !== CONFIG_KEY && e.key !== WORDS_KEY) return
  if (e.key === CONFIG_KEY) config = loadConfig()
  else {
    personal.clear()
    for (const w of loadPersonal()) personal.add(w)
  }
  applyConfig()
})

export function addToDictionary(word: string): void {
  personal.add(word.toLowerCase())
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify([...personal]))
  } catch {
    /* best effort */
  }
  refreshAll()
}

/** Known without asking hunspell: our jargon, plus whatever the user added. */
function isKnownWord(word: string): boolean {
  const lower = word.toLowerCase()
  return personal.has(lower) || TECH_WORDS.has(lower)
}

// ── worker plumbing ────────────────────────────────────────────────────────────

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (r: WorkerResponse) => void>()

function client(): Worker {
  if (!worker) {
    worker = new SpellWorker()
    worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const resolve = pending.get(e.data.id)
      pending.delete(e.data.id)
      resolve?.(e.data)
    }
    worker.postMessage({ type: 'config', langs: config.langs } satisfies WorkerRequest)
  }
  return worker
}

type Ask = { type: 'check'; words: string[] } | { type: 'suggest'; word: string }

function ask(msg: Ask): Promise<WorkerResponse> {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    client().postMessage({ ...msg, id })
  })
}

/** word → is it spelled correctly, per the currently enabled languages */
const verdicts = new Map<string, boolean>()

async function judge(words: string[]): Promise<void> {
  const unknown = [...new Set(words)].filter((w) => !verdicts.has(w))
  if (!unknown.length) return
  const res = await ask({ type: 'check', words: unknown })
  if (res.type !== 'checked') return
  const bad = new Set(res.bad)
  for (const w of unknown) verdicts.set(w, !bad.has(w))
  if (verdicts.size > CACHE_MAX) verdicts.clear()
}

// ── attached editors ──────────────────────────────────────────────────────────

interface Attached {
  model: monaco.editor.ITextModel
  mode: SpellMode
  timer: ReturnType<typeof setTimeout> | null
}

const attached = new Set<Attached>()

/**
 * Spell-check an editor's model until the returned disposable is called.
 * `mode` decides what counts as prose (see extractWords).
 */
export function attachSpellcheck(
  editor: monaco.editor.IStandaloneCodeEditor,
  mode: SpellMode
): monaco.IDisposable {
  const model = editor.getModel()
  if (!model) return { dispose: () => {} }

  const entry: Attached = { model, mode, timer: null }
  attached.add(entry)

  const schedule = (): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void refresh(entry)
    }, DEBOUNCE_MS)
  }

  const sub = model.onDidChangeContent(schedule)
  void refresh(entry)

  return {
    dispose: () => {
      sub.dispose()
      if (entry.timer) clearTimeout(entry.timer)
      attached.delete(entry)
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
    }
  }
}

function refreshAll(): void {
  for (const entry of attached) void refresh(entry)
}

async function refresh(entry: Attached): Promise<void> {
  const { model, mode } = entry
  if (model.isDisposed()) return
  // No languages means no spell checking. Without this guard an empty set would
  // mean *nothing* recognises any word, and the whole document would squiggle.
  if (!config.enabled || !config.langs.length) {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
    return
  }
  // the text may change while the worker answers; re-derive and retry rather
  // than mark stale positions (a couple of passes, then let the debounce win)
  for (let pass = 0; pass < 3; pass++) {
    const version = model.getVersionId()
    const hits = extractWords(model.getValue(), mode).filter((h) => !isKnownWord(h.word))
    const missing = hits.map((h) => h.word).filter((w) => !verdicts.has(w))
    if (missing.length) {
      await judge(missing)
      if (model.isDisposed()) return
      if (model.getVersionId() !== version) continue
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, hits.filter(isBad).map(toMarker))
    return
  }
}

function isBad(hit: WordHit): boolean {
  return verdicts.get(hit.word) === false
}

function toMarker(hit: WordHit): monaco.editor.IMarkerData {
  return {
    severity: monaco.MarkerSeverity.Info,
    source: MARKER_SOURCE,
    message: `“${hit.word}”: unknown word`,
    startLineNumber: hit.line,
    startColumn: hit.column,
    endLineNumber: hit.line,
    endColumn: hit.column + hit.word.length
  }
}

// ── quick fixes ───────────────────────────────────────────────────────────────

/** Register the spelling quick fixes for the given Monaco languages (once). */
export function registerSpellActions(languages: string[]): void {
  monaco.editor.addCommand({
    id: ADD_COMMAND,
    run: (_accessor, word: string) => addToDictionary(word)
  })
  for (const language of languages) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions: async (model, _range, context) => {
        const markers = context.markers.filter((m) => m.source === MARKER_SOURCE)
        if (!markers.length) return { actions: [], dispose: () => {} }
        const actions: monaco.languages.CodeAction[] = []
        for (const marker of markers) {
          const range = {
            startLineNumber: marker.startLineNumber,
            startColumn: marker.startColumn,
            endLineNumber: marker.endLineNumber,
            endColumn: marker.endColumn
          }
          const word = model.getValueInRange(range)
          const res = await ask({ type: 'suggest', word })
          const suggestions = res.type === 'suggested' ? res.suggestions : []
          suggestions.slice(0, MAX_SUGGESTIONS).forEach((text, i) => {
            actions.push({
              title: `Change to “${text}”`,
              kind: 'quickfix',
              diagnostics: [marker],
              isPreferred: i === 0,
              edit: {
                edits: [
                  {
                    resource: model.uri,
                    versionId: model.getVersionId(),
                    textEdit: { range, text }
                  }
                ]
              }
            })
          })
          actions.push({
            title: `Add “${word}” to dictionary`,
            kind: 'quickfix',
            diagnostics: [marker],
            command: { id: ADD_COMMAND, title: 'Add to dictionary', arguments: [word] }
          })
        }
        return { actions, dispose: () => {} }
      }
    })
  }
}
