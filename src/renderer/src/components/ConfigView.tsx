import { useEffect, useMemo, useState } from 'react'
import type { ConfigEntry, ProjectConfigFiles } from '../../../shared/types'
import { MAX_EDIT_BYTES } from '../../../shared/types'
import { useFileEditor } from '../file-editor'
import { formatBytes } from '../format'

interface Props {
  tabId: string
  /** bumped by the owner tab re-opening the window — forces a re-scan */
  reloadKey: number
}

/** Case-insensitive substring match on the path shown in the rail. */
function matchesFilter(entry: ConfigEntry, filter: string): boolean {
  return !filter || entry.rel.toLowerCase().includes(filter.toLowerCase())
}

export function ConfigView({ tabId, reloadKey }: Props): React.JSX.Element {
  const [files, setFiles] = useState<ProjectConfigFiles | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  // bumped after saving the patterns file, which changes what the scan returns
  const [rescan, setRescan] = useState(0)
  // files the user answered the size warning for ("Open anyway")
  const [oversizeOk, setOversizeOk] = useState<Set<string>>(new Set())
  const patternsFile = files?.patternsFile

  const editor = useFileEditor<ConfigEntry>({
    io: {
      read: (path) => window.claudeTerm.readConfigFile(tabId, path, oversizeOk.has(path)),
      write: (path, content) => window.claudeTerm.writeConfigFile(tabId, path, content),
      reportDirty: (d) => window.claudeTerm.configDirty(d),
      onRequestSave: (cb) => window.claudeTerm.onConfigRequestSave(cb),
      saveDone: () => window.claudeTerm.configSaveDone()
    },
    scheme: 'claude-config',
    editing: true,
    // don't even read a file we refuse to open — render explains it instead
    readable: (e) => e.size <= MAX_EDIT_BYTES || oversizeOk.has(e.path),
    options: { renderWhitespace: 'selection', tabSize: 2 },
    // the patterns file decides what the scan lists — re-run it once saved
    onSaved: (e) => {
      if (e.path === patternsFile) setRescan((n) => n + 1)
    }
  })
  const { selected, content, dirty, saving, save, hostRef } = editor

  useEffect(() => {
    let live = true
    window.claudeTerm.listConfigFiles(tabId).then((f) => {
      if (!live) return
      setFiles(f)
      // keeps the open file selected across a re-scan; else opens the first
      editor.reselect(f.sections.flatMap((s) => s.entries))
      setLoading(false)
    })
    return () => {
      live = false
    }
    // the re-scan triggers only — `editor.reselect` is stable and reads the open
    // path from a ref, so listing again never drops an unsaved draft
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, reloadKey, rescan])

  const tooLarge = !!selected && selected.size > MAX_EDIT_BYTES && !oversizeOk.has(selected.path)
  const openAnyway = (): void => {
    if (selected) setOversizeOk((prev) => new Set(prev).add(selected.path))
  }

  const selectFile = (e: ConfigEntry): void => {
    if (e.path === selected?.path || !editor.confirmDiscard()) return
    editor.select(e)
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
                {formatBytes(selected.size)}
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
                    This file is {formatBytes(selected.size)} — big enough to slow the editor down.{' '}
                    <button className="docs-btn" onClick={openAnyway}>
                      Open anyway
                    </button>
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
