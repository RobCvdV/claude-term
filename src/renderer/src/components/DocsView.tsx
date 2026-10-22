import { useEffect, useMemo, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { DocGroup, DocTarget, ProjectDocs } from '../../../shared/types'
import { MAX_EDIT_BYTES } from '../../../shared/types'
import { MARKDOWN_LANG } from '../monaco-setup'
import { landingFor, modeFor, railGroups, type FileItem } from '../docs-rail'
import { isBinaryImage, previewKind } from '../../../shared/preview-kind'
import { attachSpellcheck } from '../spell'
import { attachGrammar } from '../grammar'
import { useFileEditor } from '../file-editor'
import { formatBytes } from '../format'
import { FileRail, type RevealRequest } from './FileRail'
import { revealLabel } from '../../../shared/reveal-label'
import { renderMarkdown } from '../markdown'

/** Where a terminal file link wants the cursor. */
interface CursorAt {
  line: number
  column?: number
}

const editorPath = (ed: monacoNs.editor.IStandaloneCodeEditor): string | undefined =>
  ed.getModel()?.uri.path

function revealAt(ed: monacoNs.editor.IStandaloneCodeEditor, at: CursorAt): void {
  // a stale line number (the file shrank since it was printed) still lands in it
  const lineNumber = Math.min(at.line, ed.getModel()?.getLineCount() ?? 1)
  ed.setPosition({ lineNumber, column: at.column ?? 1 })
  ed.revealLineInCenter(lineNumber)
  ed.focus()
}

/** The mode a file can actually be shown in: a raster image has no text to
 *  edit, and a file with nothing to preview has only the editor. */
function modeAllowed(path: string, wanted: 'view' | 'edit'): 'view' | 'edit' {
  if (isBinaryImage(path)) return 'view'
  return previewKind(path) ? wanted : 'edit'
}

interface Props {
  tabId: string
  /** which section to focus — changes when the owner tab re-opens the window */
  group: DocGroup
  /** one specific doc to open (a just-created `/add-file`), instead of the
   *  group's first entry — with `edit` it opens straight in the editor */
  target?: DocTarget | null
  /** the file now on screen, for the window's own title */
  onOpenFile?: (label: string | null) => void
}

export function DocsView({ tabId, group, target, onOpenFile }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  // a doc handed to us for editing (/add-file) starts with the cursor at the
  // end, under its seeded heading; consumed by the editor on mount, so a later
  // View→Edit toggle still opens at the top like any other doc
  const openAtEnd = useRef(false)
  // Where a `path:line` terminal link wants the cursor. Applied on mount for a
  // file the editor isn't showing yet, and straight away for one it is — a
  // second link into the open file must still move the cursor.
  const openAtLine = useRef<CursorAt | null>(null)
  const edRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
  // Enter on a rail row: the editor takes the keyboard once it is up
  const focusOnAttach = useRef(false)
  const previewRef = useRef<HTMLDivElement>(null)
  // bumped when files may have changed on disk, so the rail re-reads them
  const [railRefresh, setRailRefresh] = useState(0)
  const [reveal, setReveal] = useState<RevealRequest | null>(null)
  // files the user answered the size warning for ("Open anyway")
  const [oversizeOk, setOversizeOk] = useState<Set<string>>(new Set())
  // bumped after saving the pattern list, which changes what settings lists
  const [rescan, setRescan] = useState(0)
  // a file this window just created: it wins the selection on the re-list that
  // follows, instead of the group's usual landing
  const justCreated = useRef<string | null>(null)
  const [newFileError, setNewFileError] = useState<string | null>(null)
  const patternsFile = docs?.patternsFile

  const editor = useFileEditor<FileItem>({
    io: {
      read: (path) => window.claudeTerm.readDoc(tabId, path, oversizeOk.has(path)),
      write: (path, content) => window.claudeTerm.writeDoc(tabId, path, content),
      reportDirty: (d) => window.claudeTerm.docsDirty(d),
      onRequestSave: (cb) => window.claudeTerm.onDocsRequestSave(cb),
      saveDone: () => window.claudeTerm.docsSaveDone()
    },
    scheme: 'claude-doc',
    editing: mode === 'edit',
    // a generated file shouldn't be able to hang the editor; the warning below
    // offers to open it anyway, which is what puts it in `oversizeOk`
    readable: (e) => !isBinaryImage(e.path) && (e.size <= MAX_EDIT_BYTES || oversizeOk.has(e.path)),
    options: { wordWrap: 'on', renderWhitespace: 'none' },
    // the pattern list decides what the settings groups hold — re-list once saved
    onSaved: (e) => {
      setRailRefresh((n) => n + 1)
      if (e.path === patternsFile) setRescan((n) => n + 1)
    },
    attach: (ed, language) => {
      if (openAtEnd.current) {
        openAtEnd.current = false
        const model = ed.getModel()
        if (model) ed.setPosition(model.getFullModelRange().getEndPosition())
      }
      edRef.current = ed
      if (focusOnAttach.current) {
        focusOnAttach.current = false
        ed.focus()
      }
      if (openAtLine.current) {
        revealAt(ed, openAtLine.current)
        openAtLine.current = null
      }
      const subs: monacoNs.IDisposable[] = [
        {
          dispose: () => {
            if (edRef.current === ed) edRef.current = null
          }
        }
      ]
      // prose only: spelling and grammar on code or config would be all noise,
      // and their quick fixes are registered for markdown anyway
      if (language === MARKDOWN_LANG) subs.push(attachSpellcheck(ed, 'markdown'), attachGrammar(ed))
      return subs
    }
  })
  const { selected, content, shown, dirty, saving, save, hostRef } = editor
  const { changedOnDisk, reloadFromDisk, keepMine } = editor

  useEffect(() => {
    onOpenFile?.(selected?.label ?? null)
  }, [selected?.label, onOpenFile])

  useEffect(() => {
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (!live) return
      setDocs(d)
      const created = justCreated.current
      justCreated.current = null
      const landing = landingFor(d, { created, target, group })
      editor.select(landing.item)
      setMode(landing.item ? modeAllowed(landing.item.path, landing.mode) : landing.mode)
      if (landing.item) {
        const { path } = landing.item
        const prefer = target || created ? 'tree' : 'quick'
        setReveal((r) => ({ path, prefer, n: (r?.n ?? 0) + 1 }))
      }
      openAtEnd.current = landing.atEnd
      const at = landing.line ? { line: landing.line, column: landing.column } : null
      openAtLine.current = at
      // already the open file: no editor is mounted for this, so move the cursor
      if (at && edRef.current && editorPath(edRef.current) === landing.item?.path) {
        revealAt(edRef.current, at)
        openAtLine.current = null
      }
      setLoading(false)
    })
    return () => {
      live = false
    }
    // a re-target is only ever a new path/mode, so depend on those, not identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, group, target?.path, target?.edit, target?.line, target?.column, rescan])

  /**
   * "New file": the OS save dialog picks the folder and the name (starting next
   * to the open file), main creates it, and it opens here in edit mode. The
   * dialog can reach anywhere, so main refuses paths outside the project — that
   * refusal is what the error line reports.
   */
  const newFile = async (): Promise<void> => {
    if (!editor.confirmDiscard()) return
    setNewFileError(null)
    const near = selected?.path.replace(/\/[^/]*$/, '')
    const made = await window.claudeTerm.newDocFile(tabId, near)
    if (!made) return // cancelled
    if (!made.ok) {
      setNewFileError(made.error)
      return
    }
    justCreated.current = made.path
    setRailRefresh((n) => n + 1)
    setRescan((n) => n + 1)
  }

  const binary = !!selected && isBinaryImage(selected.path)
  const tooLarge =
    !!selected && !binary && selected.size > MAX_EDIT_BYTES && !oversizeOk.has(selected.path)
  const openAnyway = (): void => {
    if (selected) setOversizeOk((prev) => new Set(prev).add(selected.path))
  }

  // what View shows depends on the type; a file with no kind only has the editor
  const kind = selected ? previewKind(selected.path) : 'markdown'
  const rendered = useMemo(
    () => (shown && kind === 'markdown' ? renderMarkdown(shown) : ''),
    [shown, kind]
  )
  const [image, setImage] = useState<{ path: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!selected || !binary) return
    let live = true
    const { path } = selected
    void window.claudeTerm.readDocImage(tabId, path).then((url) => {
      if (live) setImage({ path, url })
    })
    return () => {
      live = false
    }
  }, [tabId, selected, binary])
  const imageSrc =
    kind !== 'image'
      ? null
      : binary
        ? image?.path === selected?.path
          ? image?.url
          : undefined
        : shown != null
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shown)}`
          : undefined

  const togglePreview = (): void => {
    if (!selected || !kind || binary || content == null) return
    const toEdit = mode === 'view'
    focusOnAttach.current = toEdit
    setMode(toEdit ? 'edit' : 'view')
    if (!toEdit) requestAnimationFrame(() => previewRef.current?.focus())
  }
  const focusContent = (): void => {
    if (mode === 'edit') edRef.current?.focus()
    else previewRef.current?.focus()
  }

  // ⌘E to the editor (or the page in View) and ⌘P between the two, from anywhere
  // in the window — ahead of Monaco, whose ⌘E is "use selection for find"
  const keysRef = useRef({ togglePreview, focusContent })
  useEffect(() => {
    keysRef.current = { togglePreview, focusContent }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.code === 'KeyE') keysRef.current.focusContent()
      else if (e.code === 'KeyP') keysRef.current.togglePreview()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onPreviewClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.open(href)
  }

  const listed = docs ? railGroups(docs).reduce((n, g) => n + g.items.length, 0) : 0
  const empty = !docs || (!listed && !docs.roots.length)

  const selectFile = (e: FileItem, focusEditor = false): void => {
    if (e.path === selected?.path) {
      if (focusEditor) edRef.current?.focus()
      return
    }
    if (!editor.confirmDiscard()) return
    setNewFileError(null)
    focusOnAttach.current = focusEditor
    // switching files drops any draft — the hook's job
    editor.select(e)
    setMode(modeFor(e.path))
    // the editor gets the keys when it mounts; a page has nothing to wait for
    if (focusEditor && modeFor(e.path) === 'view') {
      requestAnimationFrame(() => previewRef.current?.focus())
    }
  }

  return (
    <div className="docs-window">
      <div className="docs-panel">
        <div className="activity-head">
          <span className="activity-title">
            {selected?.label ?? 'Files'}
            {dirty && (
              <span className="docs-dirty" title="Unsaved changes">
                {' '}
                ●
              </span>
            )}
          </span>
          <div className="docs-actions">
            <button
              className="docs-btn"
              onClick={() => void newFile()}
              title="Create a file — pick the folder and name"
            >
              + New file
            </button>
            {selected && (
              <>
                {!!selected.size && (
                  <span className="config-meta" title={selected.path}>
                    {formatBytes(selected.size)}
                  </span>
                )}
                {dirty && (
                  <button
                    className="docs-btn docs-save"
                    onClick={() => void save()}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
                {kind && !binary && (
                  <button
                    className="docs-btn"
                    onClick={togglePreview}
                    disabled={content == null}
                    title={mode === 'edit' ? 'Preview this file (⌘P)' : 'Edit this file (⌘P)'}
                  >
                    {mode === 'edit' ? 'View' : 'Edit'}
                  </button>
                )}
                <button
                  className="docs-btn"
                  onClick={() => window.claudeTerm.revealDoc(tabId, selected.path)}
                  title={`${revealLabel(window.claudeTerm.platform)} — the folder opens with this file selected`}
                >
                  {revealLabel(window.claudeTerm.platform)}
                </button>
                <button
                  className="docs-btn"
                  onClick={() => window.claudeTerm.openDoc(tabId, selected.path)}
                  title="Open in default app for editing"
                >
                  Open ↗
                </button>
              </>
            )}
          </div>
        </div>
        {newFileError && (
          <div
            className="docs-error"
            title="Click to dismiss"
            onClick={() => setNewFileError(null)}
          >
            {newFileError}
          </div>
        )}
        {changedOnDisk && (
          <div className="docs-conflict">
            <span>
              {selected?.label ?? 'This file'} changed on disk while you have unsaved edits.
            </span>
            <button className="docs-btn" onClick={reloadFromDisk}>
              Reload from disk
            </button>
            <button
              className="docs-btn"
              onClick={keepMine}
              title="Saving will overwrite the disk version"
            >
              Keep mine
            </button>
          </div>
        )}

        <div className="docs-body">
          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : empty ? (
            <p className="activity-empty">Nothing to show for this project.</p>
          ) : (
            <>
              <FileRail
                tabId={tabId}
                docs={docs!}
                selectedPath={selected?.path}
                onOpen={selectFile}
                refresh={railRefresh}
                reveal={reveal}
              />
              {tooLarge ? (
                <div className="docs-preview">
                  <p className="activity-empty">
                    This file is {formatBytes(selected.size)} — big enough to slow the editor down.{' '}
                    <button className="docs-btn" onClick={openAnyway}>
                      Open anyway
                    </button>
                  </p>
                </div>
              ) : mode === 'edit' ? (
                <div className="docs-editor" ref={hostRef} />
              ) : (
                <div
                  className={`docs-preview ${kind ? `preview-${kind}` : ''}`}
                  onClick={onPreviewClick}
                  ref={previewRef}
                  tabIndex={-1}
                >
                  {kind === 'image' ? (
                    imageSrc === undefined ? (
                      <p className="activity-empty">Loading…</p>
                    ) : imageSrc === null ? (
                      <p className="activity-empty">
                        Can&apos;t show this image here — Space in the rail Quick Looks it.
                      </p>
                    ) : (
                      <img src={imageSrc} alt={selected?.label} />
                    )
                  ) : shown == null ? (
                    <p className="activity-empty">Loading…</p>
                  ) : kind === 'html' ? (
                    // no scripts, no same-origin: the page is shown, never run
                    <iframe sandbox="" srcDoc={shown} title={selected?.label} />
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: rendered }} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
