// Grammar checking for the docs editor: Harper's findings become Info markers
// (the same muted squiggle as spelling — a style nitpick shouldn't look like an
// error) with its replacements offered as quick fixes.
//
// Deliberately kept separate from spell/: the two share about fifteen lines of
// shape, and nothing else. Spelling caches verdicts per word and runs in both
// editors; grammar lints whole documents and only runs here, so the prompt box
// never pays for a 15MB wasm load.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import GrammarWorker from './harper.worker?worker'
import { usableFindings } from './findings'
import type { Finding, WorkerRequest, WorkerResponse } from './protocol'
import { getSpellConfig, onSpellConfigChange } from '../spell'

const MARKER_OWNER = 'grammar'
const MARKER_SOURCE = 'grammar'
const DEBOUNCE_MS = 400
const MAX_FIXES = 6

// ── worker plumbing ───────────────────────────────────────────────────────────

let worker: Worker | null = null
let ready: Promise<boolean> | null = null
let seq = 0
const pending = new Map<number, (r: WorkerResponse) => void>()

/**
 * Spin up Harper on first use: bytes from the main process (see the grammar:wasm
 * IPC handler) → blob URL in the worker. Resolves false when the wasm is missing
 * or won't compile, and every later call short-circuits on the same promise.
 */
function client(): Promise<boolean> {
  if (ready) return ready
  ready = (async () => {
    const wasm = await window.claudeTerm.grammarWasm()
    if (!wasm) return false
    const w = new GrammarWorker()
    const readyAck = new Promise<boolean>((resolve) => {
      w.onmessage = (e: MessageEvent<WorkerResponse>): void => {
        if (e.data.type === 'ready') {
          // swap in the steady-state handler now that setup has answered
          w.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
            if (ev.data.type !== 'linted') return
            const resolveLint = pending.get(ev.data.id)
            pending.delete(ev.data.id)
            resolveLint?.(ev.data)
          }
          resolve(e.data.ok)
        }
      }
    })
    w.postMessage({ type: 'init', wasm } satisfies WorkerRequest)
    worker = w
    return readyAck
  })()
  return ready
}

async function lint(text: string): Promise<Finding[]> {
  if (!(await client()) || !worker) return []
  const id = ++seq
  const res = await new Promise<WorkerResponse>((resolve) => {
    pending.set(id, resolve)
    worker?.postMessage({ type: 'lint', id, text } satisfies WorkerRequest)
  })
  return res.type === 'linted' ? res.findings : []
}

// ── attached editors ──────────────────────────────────────────────────────────

interface Attached {
  model: monaco.editor.ITextModel
  timer: ReturnType<typeof setTimeout> | null
}

const attached = new Set<Attached>()

/** Grammar-check an editor's model until the returned disposable is called. */
export function attachGrammar(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const model = editor.getModel()
  if (!model) return { dispose: () => {} }

  const entry: Attached = { model, timer: null }
  attached.add(entry)

  const sub = model.onDidChangeContent(() => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void refresh(entry)
    }, DEBOUNCE_MS)
  })
  const unsubscribe = onSpellConfigChange(() => void refresh(entry))
  void refresh(entry)

  return {
    dispose: () => {
      sub.dispose()
      unsubscribe()
      if (entry.timer) clearTimeout(entry.timer)
      attached.delete(entry)
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
    }
  }
}

async function refresh(entry: Attached): Promise<void> {
  const { model } = entry
  if (model.isDisposed()) return
  const config = getSpellConfig()
  if (!config.enabled || !config.grammar) {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
    return
  }
  const version = model.getVersionId()
  const findings = await lint(model.getValue())
  // the document moved while harper was thinking — the debounce will re-run
  if (model.isDisposed() || model.getVersionId() !== version) return
  const kept = usableFindings(findings)
  // markers can't carry arbitrary data, so park the findings for the quick-fix
  // provider to look up by span instead of re-linting to fill a menu
  lastFindings.set(model, kept)
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    kept.map((f) => toMarker(f, model))
  )
}

const lastFindings = new WeakMap<monaco.editor.ITextModel, Finding[]>()

function toMarker(finding: Finding, model: monaco.editor.ITextModel): monaco.editor.IMarkerData {
  const start = model.getPositionAt(finding.start)
  const end = model.getPositionAt(finding.end)
  return {
    severity: monaco.MarkerSeverity.Info,
    source: MARKER_SOURCE,
    message: `${finding.message} (${finding.kind})`,
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
}

// ── quick fixes ───────────────────────────────────────────────────────────────

/** Register grammar quick fixes for the given Monaco languages (once). */
export function registerGrammarActions(languages: string[]): void {
  for (const language of languages) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions: (model, _range, context) => {
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
          const finding = findingFor(model, range)
          finding?.replacements.slice(0, MAX_FIXES).forEach((text, i) => {
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
        }
        return { actions, dispose: () => {} }
      }
    })
  }
}

function findingFor(model: monaco.editor.ITextModel, range: monaco.IRange): Finding | undefined {
  const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn })
  const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn })
  return lastFindings.get(model)?.find((f) => f.start === start && f.end === end)
}
