import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { ChangedFile, ProjectChanges } from '../../../shared/types'
import { setupMonaco } from '../monaco-setup'
import { languageForFile } from '../config-lang'
import {
  changeBadge,
  emptyReason,
  initialScope,
  inTurn,
  reselectChange,
  revertConfirmText,
  revertSummary,
  scopedFiles,
  totals,
  turnDepths,
  turnLabel,
  turnStep,
  type DiffScope
} from '../diff-rail'

/**
 * What the turn just did to the working tree, as a Monaco diff against HEAD.
 * Read-only: this window is for reviewing Claude's edits, and the file window
 * next door is where they get changed.
 */

interface Props {
  tabId: string
  /** the file now on screen, for the window's own title */
  onOpenFile?: (label: string | null) => void
}

interface Sides {
  path: string
  /** the committed text; empty for a file HEAD never had */
  original: string
  /** what is on disk now; empty for a file the turn deleted */
  modified: string
}

export function DiffView({ tabId, onOpenFile }: Props): React.JSX.Element {
  const [changes, setChanges] = useState<ProjectChanges | null>(null)
  const [scope, setScope] = useState<DiffScope | null>(null)
  /** how many turns back the turn scope reaches (1 = the turn that just ran) */
  const [depth, setDepth] = useState(1)
  const [openPath, setOpenPath] = useState<string | undefined>(undefined)
  const [sides, setSides] = useState<Sides | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [reloads, setReloads] = useState(0)
  const [reverting, setReverting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const reload = useCallback(() => setReloads((n) => n + 1), [])

  useEffect(() => {
    let live = true
    void window.claudeTerm.gitChanges(tabId).then((next) => {
      if (!live) return
      setChanges(next)
      // the scope is only chosen for us the first time; after that it is the
      // user's toggle, and a refresh must not undo it
      setScope((current) => current ?? initialScope(next))
    })
    return () => {
      live = false
    }
  }, [tabId, reloads])

  // A turn finishing is not something this window hears about, so re-read the
  // moment it is looked at again.
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  const files = useMemo(
    () => (changes && scope ? scopedFiles(changes, scope, depth) : []),
    [changes, scope, depth]
  )
  const selected = useMemo(() => reselectChange(files, openPath), [files, openPath])
  const sum = useMemo(() => totals(files), [files])

  useEffect(() => {
    onOpenFile?.(selected?.rel ?? null)
  }, [selected?.rel, onOpenFile])

  useEffect(() => {
    const path = selected?.path
    if (!path) return
    let live = true
    void Promise.all([
      window.claudeTerm.gitFileAtHead(tabId, path),
      // oversize is allowed through: a diff of a big generated file is still the
      // honest answer, and the editor is read-only here
      window.claudeTerm.readDoc(tabId, path, true)
    ]).then(([original, modified]) => {
      if (live) setSides({ path, original: original ?? '', modified: modified ?? '' })
    })
    return () => {
      live = false
    }
  }, [tabId, selected?.path, reloads])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const ready = sides?.path === selected?.path
  useEffect(() => {
    const host = hostRef.current
    if (!host || !selected || !sides || sides.path !== selected.path) return
    const monaco = setupMonaco()
    const language = languageForFile(selected.path)
    const model = (scheme: string, text: string): monacoNs.editor.ITextModel => {
      const uri = monaco.Uri.parse(`${scheme}://${selected.path}`)
      const existing = monaco.editor.getModel(uri)
      if (existing) {
        existing.setValue(text)
        return existing
      }
      return monaco.editor.createModel(text, language, uri)
    }
    const original = model('claude-head', sides.original)
    const modified = model('claude-work', sides.modified)
    const editor = monaco.editor.createDiffEditor(host, {
      theme: 'claude-term',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false
    })
    editor.setModel({ original, modified })
    return () => {
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [selected, sides, sideBySide])

  const empty = changes && scope ? emptyReason(changes, scope, depth) : null
  const turnFiles = changes ? scopedFiles(changes, 'turn', depth) : []
  const turnCount = turnFiles.length
  const depths = changes ? turnDepths(changes) : []
  const step = changes ? turnStep(changes, depth) : null

  const revert = async (): Promise<void> => {
    if (!turnFiles.length || !window.confirm(revertConfirmText(turnFiles, depth))) return
    setReverting(true)
    const result = await window.claudeTerm.revertTurn(tabId, depth)
    setReverting(false)
    setNote(
      result
        ? revertSummary(result)
        : `No checkpoint for ${
            depth === 1 ? 'this turn' : `turn ${depth}`
          } — it started before the app did.`
    )
    reload()
  }

  const row = (file: ChangedFile): React.JSX.Element => (
    <button
      key={file.path}
      className={`docs-item diff-item ${selected?.path === file.path ? 'active' : ''}`}
      onClick={() => setOpenPath(file.path)}
      title={file.path}
    >
      <span className={`diff-badge diff-${file.kind}`}>{changeBadge(file.kind)}</span>
      <span className="diff-path">{file.rel}</span>
      {changes && inTurn(changes, file, depth) && (
        <span className="diff-turn-dot" title={`Changed by ${turnLabel(depth).toLowerCase()}`}>
          ●
        </span>
      )}
      <span className="diff-counts">
        {!!file.added && <span className="diff-added">+{file.added}</span>}
        {!!file.removed && <span className="diff-removed">−{file.removed}</span>}
      </span>
    </button>
  )

  return (
    <div className="docs-window">
      <div className="docs-panel">
        <div className="activity-head">
          <span className="activity-title">{selected?.rel ?? 'Changes'}</span>
          <div className="docs-actions">
            <span className="config-meta">
              {files.length} file{files.length === 1 ? '' : 's'}
              {!!sum.added && <span className="diff-added"> +{sum.added}</span>}
              {!!sum.removed && <span className="diff-removed"> −{sum.removed}</span>}
            </span>
            <button
              className={`docs-btn ${scope === 'turn' ? 'docs-save' : ''}`}
              onClick={() => setScope('turn')}
              disabled={!changes}
              title={
                step?.startedAt
                  ? `Files written since ${new Date(step.startedAt).toLocaleTimeString()}`
                  : 'Files the turn wrote to'
              }
            >
              {turnLabel(depth)} ({turnCount})
            </button>
            {scope === 'turn' && depths.length > 1 && (
              <select
                className="docs-btn diff-depth"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                title="How far back to go — one step per turn"
              >
                {depths.map((d) => {
                  const t = turnStep(changes!, d)
                  const at = t?.startedAt ? new Date(t.startedAt).toLocaleTimeString() : null
                  return (
                    <option key={d} value={d}>
                      {d === 1 ? '1 turn' : `${d} turns`}
                      {at ? ` · from ${at}` : ''}
                      {t?.revertable ? '' : ' · no undo'}
                    </option>
                  )
                })}
              </select>
            )}
            <button
              className={`docs-btn ${scope === 'all' ? 'docs-save' : ''}`}
              onClick={() => setScope('all')}
              disabled={!changes}
              title="Everything that differs from HEAD"
            >
              All ({changes?.files.length ?? 0})
            </button>
            <button
              className="docs-btn"
              onClick={() => setSideBySide((s) => !s)}
              title={sideBySide ? 'Show as one column' : 'Show side by side'}
            >
              {sideBySide ? 'Inline' : 'Side by side'}
            </button>
            {scope === 'turn' && turnCount > 0 && (
              <button
                className="docs-btn diff-revert"
                onClick={() => void revert()}
                disabled={reverting || !step?.revertable}
                title={
                  step?.revertable
                    ? 'Put these files back to how they were when that turn started'
                    : 'No restore point for that turn — it started before the app did'
                }
              >
                {reverting ? 'Reverting…' : `Revert ${turnLabel(depth).toLowerCase()}`}
              </button>
            )}
            <button className="docs-btn" onClick={reload} title="Re-read the working tree">
              Refresh
            </button>
          </div>
        </div>
        {note && (
          <div className="docs-error diff-note" onClick={() => setNote(null)}>
            {note}
          </div>
        )}
        <div className="docs-body">
          <div className="docs-rail">
            <div className="docs-section">
              <div className="docs-section-title">
                {scope === 'turn' ? turnLabel(depth) : 'Working tree'}
              </div>
              {files.map(row)}
            </div>
          </div>
          {empty || !selected ? (
            <p className="activity-empty">{empty ?? 'Loading…'}</p>
          ) : (
            <div className="docs-editor" ref={hostRef} key={ready ? 'ready' : 'loading'} />
          )}
        </div>
      </div>
    </div>
  )
}
