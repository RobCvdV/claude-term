import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigEntry, ProjectConfigFiles } from '../../../shared/types'
import { MAX_CONFIG_EDIT_BYTES } from '../../../shared/types'
import { languageForFile } from '../config-lang'
import { setupMonaco } from '../monaco-setup'

interface Props {
  tabId: string
  /** bumped by the owner tab re-opening the window — forces a re-scan */
  reloadKey: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Case-insensitive substring match on the path shown in the rail. */
function matchesFilter(entry: ConfigEntry, filter: string): boolean {
  return !filter || entry.rel.toLowerCase().includes(filter.toLowerCase())
}

export function ConfigView({ tabId, reloadKey }: Props): React.JSX.Element {
  const [files, setFiles] = useState<ProjectConfigFiles | null>(null)
  const [selected, setSelected] = useState<ConfigEntry | null>(null)
  // keyed to its path so a stale file never shows while the next one loads
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState('')
  // bumped after saving the patterns file, which changes what the scan returns
  const [rescan, setRescan] = useState(0)

  useEffect(() => {
    let live = true
    window.claudeTerm.listConfigFiles(tabId).then((f) => {
      if (!live) return
      setFiles(f)
      // keep the open file selected across a re-scan; else open the first one
      setSelected((prev) => {
        const all = f.sections.flatMap((s) => s.entries)
        return (prev && all.find((e) => e.path === prev.path)) ?? all[0] ?? null
      })
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tabId, reloadKey, rescan])

  useEffect(() => {
    // don't even read a file we refuse to open — render explains it instead
    if (!selected || selected.size > MAX_CONFIG_EDIT_BYTES) return
    let live = true
    window.claudeTerm.readConfigFile(tabId, selected.path).then((c) => {
      if (live) setLoaded({ path: selected.path, text: c })
    })
    return () => {
      live = false
    }
  }, [tabId, selected])

  const content = selected && loaded?.path === selected.path ? loaded.text : null
  const dirty = draft != null && draft !== content
  const tooLarge = !!selected && selected.size > MAX_CONFIG_EDIT_BYTES

  const save = useCallback(async (): Promise<void> => {
    if (!selected || draft == null) return
    setSaving(true)
    const ok = await window.claudeTerm.writeConfigFile(tabId, selected.path, draft)
    setSaving(false)
    if (!ok) return
    // reconcile the baseline so `dirty` clears; the editor is not recreated
    setLoaded({ path: selected.path, text: draft })
    // the patterns file decides what the scan lists — re-run it
    if (files && selected.path === files.patternsFile) setRescan((n) => n + 1)
  }, [tabId, selected, draft, files])

  // Monaco's Cmd+S command is bound once per editor, so reach the latest `save`
  // (which closes over the current draft) through a ref kept fresh in an effect.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  // Let the main process know whether there are unsaved edits, so closing the
  // window (or its tab) can prompt to save/discard first.
  useEffect(() => {
    window.claudeTerm.configDirty(dirty)
  }, [dirty])

  useEffect(() => {
    return window.claudeTerm.onConfigRequestSave(() => {
      void saveRef.current().finally(() => window.claudeTerm.configSaveDone())
    })
  }, [])

  // Monaco editor lifecycle — recreated per file, since the language differs.
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selected || content == null || !hostRef.current) return
    const monaco = setupMonaco()
    const uri = monaco.Uri.parse(`claude-config://${selected.path}`)
    const lang = languageForFile(selected.rel)
    const model =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(draft ?? content, lang, uri)
    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: 'claude-term',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2
    })
    const sub = editor.onDidChangeModelContent(() => setDraft(editor.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
    editor.focus()
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
    }
    // Recreate only on file switch — not on every content/draft change, which
    // flow FROM the editor. `content` is read once, when it first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path, content == null])

  const confirmDiscard = useCallback((): boolean => {
    return !dirty || window.confirm('Discard unsaved changes?')
  }, [dirty])

  const selectFile = (e: ConfigEntry): void => {
    if (e.path === selected?.path || !confirmDiscard()) return
    setSelected(e)
    setDraft(null)
  }

  const sections = useMemo(() => {
    if (!files) return []
    return files.sections
      .map((s) => ({ ...s, entries: s.entries.filter((e) => matchesFilter(e, filter)) }))
      .filter((s) => s.entries.length > 0)
  }, [files, filter])

  const total = files?.sections.reduce((n, s) => n + s.entries.length, 0) ?? 0
  const empty = !loading && total === 0

  return (
    <div className="docs-window config-window">
      <div className="docs-panel">
        <div className="activity-head">
          <span className="activity-title">
            {selected?.rel ?? 'Settings'}
            {dirty && (
              <span className="docs-dirty" title="Unsaved changes">
                {' '}
                ●
              </span>
            )}
          </span>
          {selected && (
            <div className="docs-actions">
              <span className="config-meta" title={selected.path}>
                {formatSize(selected.size)}
              </span>
              <button
                className="docs-btn docs-save"
                onClick={() => void save()}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>

        <div className="docs-body">
          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : empty ? (
            <p className="activity-empty">No configuration files found for this project.</p>
          ) : (
            <>
              <div className="docs-rail">
                <input
                  className="config-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Filter ${total} files…`}
                  spellCheck={false}
                />
                {sections.map((s) => (
                  <div className="docs-section" key={s.root + s.name}>
                    <div className="docs-section-title" title={s.subtitle ?? s.root}>
                      {s.name}
                      {s.subtitle && <span className="config-section-sub">{s.subtitle}</span>}
                    </div>
                    {s.entries.map((e) => (
                      <button
                        key={e.path}
                        className={`docs-item ${selected?.path === e.path ? 'active' : ''}`}
                        onClick={() => selectFile(e)}
                        title={e.path}
                      >
                        {e.rel}
                      </button>
                    ))}
                  </div>
                ))}
                {!sections.length && <p className="activity-empty">No match.</p>}
              </div>
              {tooLarge ? (
                <div className="docs-preview">
                  <p className="activity-empty">
                    This file is {formatSize(selected.size)} — too large to edit here. Open it in
                    your editor instead.
                  </p>
                </div>
              ) : content == null ? (
                <div className="docs-preview">
                  <p className="activity-empty">
                    {selected ? 'Could not read this file.' : 'Select a file.'}
                  </p>
                </div>
              ) : (
                <div className="docs-editor" ref={hostRef} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
