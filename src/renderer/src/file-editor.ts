import { useCallback, useEffect, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import { setupMonaco } from './monaco-setup'
import { attachClaudeCompletion } from './claude-complete'
import { languageForFile } from './config-lang'
import {
  contentOf,
  diskChange,
  isDirty,
  keepsDraft,
  reselect,
  shownText
} from './file-editor-state'
import type { LoadedFile } from './file-editor-state'

/**
 * The editing half of a detached file window (docs, settings): which file is
 * open, its text on disk, the unsaved draft, saving, and the Monaco instance
 * that produces the draft. Each window supplies its own listing and its own
 * chrome; this is everything they would otherwise each reimplement.
 */

/** The IPC a window kind talks to main through — read/write plus the
 *  save-before-close handshake. */
export interface FileEditorIo {
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string) => Promise<boolean>
  /** tell main whether there are unsaved edits, so a close can prompt */
  reportDirty: (dirty: boolean) => void
  /** main asking for a save before it closes us; returns an unsubscribe */
  onRequestSave: (cb: () => void) => () => void
  /** acknowledge that the requested save finished */
  saveDone: () => void
}

export interface FileEditorSpec<E extends { path: string }> {
  io: FileEditorIo
  /** Monaco model URI scheme, one per window kind so models never collide */
  scheme: string
  /** mount the editor now — the docs window only edits on demand */
  editing: boolean
  /** don't even read a file the window refuses to open (too large) */
  readable?: (entry: E) => boolean
  /** editor options layered over the shared ones */
  options?: monacoNs.editor.IStandaloneEditorConstructionOptions
  /** extras once the editor exists (spelling, cursor placement); disposed with it */
  attach?: (
    editor: monacoNs.editor.IStandaloneCodeEditor,
    language: string
  ) => monacoNs.IDisposable[]
  /** after a successful write — e.g. re-scan when the file drives the listing */
  onSaved?: (entry: E) => void
}

export interface FileEditor<E> {
  selected: E | null
  /** open a file (or nothing); drops any draft unless it is the same file */
  select: (entry: E | null) => void
  /** re-point the selection after the listing was re-scanned: keep the open
   *  file if it is still listed, else the first — an unsaved draft survives,
   *  since staying on the same file is not switching files */
  reselect: (entries: E[]) => void
  /** the text on disk: null while it loads, and when it could not be read */
  content: string | null
  /** what to render: the unsaved draft when there is one, else disk */
  shown: string | null
  dirty: boolean
  saving: boolean
  save: () => Promise<void>
  /** false when the user chose to keep unsaved edits rather than lose them */
  confirmDiscard: () => boolean
  /** host element for Monaco; it mounts while `editing` and the text is in */
  hostRef: React.RefObject<HTMLDivElement | null>
  /** the file changed on disk while there were unsaved edits */
  changedOnDisk: boolean
  /** take the disk version, dropping the unsaved edits */
  reloadFromDisk: () => void
  /** keep the edits; asked again only if the file changes once more */
  keepMine: () => void
}

/** How often an open file is re-read while its window is visible. */
const DISK_POLL_MS = 2_000

export function useFileEditor<E extends { path: string }>(spec: FileEditorSpec<E>): FileEditor<E> {
  const { io, scheme, editing } = spec
  const [selected, setSelected] = useState<E | null>(null)
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // disk text that differs from both the baseline and an unsaved draft
  const [conflict, setConflict] = useState<string | null>(null)
  // disk text the user chose to keep their edits over — not asked about again
  const ignoredDisk = useRef<string | null>(null)
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)

  // The spec the effects below read. Held in a ref (synced after each render,
  // before any other effect runs) so a caller passing fresh closures every
  // render can't remount the editor or re-read the file.
  const specRef = useRef(spec)
  useEffect(() => {
    specRef.current = spec
  })

  // the open path, for select()/reselect() — they must not depend on a render
  const openPath = useRef<string | undefined>(undefined)

  // A file the window refuses to open isn't read at all. Read as a value rather
  // than through the ref, so answering the size warning ("Open anyway") flips
  // this and re-runs the read — nothing else about the selection changed.
  const canRead = !selected || (spec.readable?.(selected) ?? true)

  useEffect(() => {
    if (!selected || !canRead) return
    let live = true
    void specRef.current.io.read(selected.path).then((text) => {
      if (live) setLoaded({ path: selected.path, text })
    })
    return () => {
      live = false
    }
  }, [selected, canRead])

  const content = contentOf(loaded, selected?.path)
  const contentReady = content != null
  const shown = shownText(draft, content)
  const dirty = isDirty(draft, content)

  // the latest disk/draft text, for the poll below without re-arming it
  const latest = useRef({ content, draft, saving })
  useEffect(() => {
    latest.current = { content, draft, saving }
  })

  /** Make `text` the disk baseline and, with no draft to protect, what shows —
   *  pushed into the open editor as an edit, so cursor, scroll and undo stay. */
  const adoptDisk = useCallback((path: string, text: string): void => {
    setLoaded({ path, text })
    setConflict(null)
    ignoredDisk.current = null
    const ed = editorRef.current
    const model = ed?.getModel()
    if (ed && model && model.getValue() !== text) {
      const view = ed.saveViewState()
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
      if (view) ed.restoreViewState(view)
    }
    setDraft(null)
  }, [])

  // Pick up changes made outside the window (Claude editing the file, git):
  // re-read on focus and every couple of seconds while the window is visible.
  useEffect(() => {
    if (!selected || !canRead || !contentReady) return
    const path = selected.path
    let live = true
    let busy = false
    const check = async (): Promise<void> => {
      if (busy || document.visibilityState !== 'visible' || latest.current.saving) return
      busy = true
      try {
        const fresh = await specRef.current.io.read(path)
        if (!live || fresh == null || fresh === ignoredDisk.current) return
        const { content: base, draft: edit } = latest.current
        const what = diskChange(base, fresh, edit)
        if (what === 'reload') adoptDisk(path, fresh)
        else if (what === 'conflict') setConflict(fresh)
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void check(), DISK_POLL_MS)
    const onFocus = (): void => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [selected, canRead, contentReady, adoptDisk])

  const select = useCallback((entry: E | null): void => {
    // a draft belongs to the file it was typed in — never carry it to another
    if (!keepsDraft(openPath.current, entry?.path)) {
      setDraft(null)
      setConflict(null)
      ignoredDisk.current = null
    }
    openPath.current = entry?.path
    setSelected(entry)
  }, [])

  const reselectFrom = useCallback(
    (entries: E[]): void => select(reselect(entries, openPath.current)),
    [select]
  )

  const save = useCallback(async (): Promise<void> => {
    if (!selected || draft == null) return
    setSaving(true)
    const ok = await specRef.current.io.write(selected.path, draft)
    setSaving(false)
    if (!ok) return
    // reconcile the baseline so `dirty` clears; the editor is not recreated
    setLoaded({ path: selected.path, text: draft })
    setConflict(null)
    ignoredDisk.current = null
    specRef.current.onSaved?.(selected)
  }, [selected, draft])

  // Monaco's Cmd+S command is bound once per editor, so reach the latest `save`
  // (which closes over the current draft) through a ref kept fresh in an effect.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  // Let the main process know whether there are unsaved edits, so closing the
  // window (or its tab) can prompt to save/discard first.
  useEffect(() => {
    io.reportDirty(dirty)
    // `io` is stable per window kind; re-running on `dirty` alone is the point
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])

  // Honour a "save before closing" request from the main process.
  useEffect(() => {
    return specRef.current.io.onRequestSave(() => {
      void saveRef.current().finally(() => specRef.current.io.saveDone())
    })
  }, [])

  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!editing || !selected || content == null || !hostRef.current) return
    const monaco = setupMonaco()
    const uri = monaco.Uri.parse(`${scheme}://${selected.path}`)
    const language = languageForFile(selected.path)
    const model =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(draft ?? content, language, uri)
    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: 'claude-term',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      inlineSuggest: { enabled: true },
      ...specRef.current.options
    })
    const subs = [
      editor.onDidChangeModelContent(() => setDraft(editor.getValue())),
      attachClaudeCompletion(editor, selected.path),
      ...(specRef.current.attach?.(editor, language) ?? [])
    ]
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
    editor.focus()
    editorRef.current = editor
    // dev builds only: lets scripts/cdp.mjs drive the editor (see the check-in-app skill)
    if (import.meta.env.DEV) Object.assign(window, { __fileEditor: editor, __monaco: monaco })
    return () => {
      editorRef.current = null
      for (const s of subs.reverse()) s.dispose()
      editor.dispose()
      model.dispose()
    }
    // Recreated only when the editor appears, the file changes, or its text
    // finally arrives — never on a content/draft change, which flow FROM the
    // editor. A window that opens straight into editing (/add-file) beats the
    // read, so `contentReady` is what mounts it in that case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selected?.path, contentReady])

  const confirmDiscard = useCallback((): boolean => {
    return !dirty || window.confirm('Discard unsaved changes?')
  }, [dirty])

  const reloadFromDisk = useCallback((): void => {
    if (selected && conflict != null) adoptDisk(selected.path, conflict)
  }, [selected, conflict, adoptDisk])

  const keepMine = useCallback((): void => {
    ignoredDisk.current = conflict
    setConflict(null)
  }, [conflict])

  return {
    changedOnDisk: conflict != null,
    reloadFromDisk,
    keepMine,
    selected,
    select,
    reselect: reselectFrom,
    content,
    shown,
    dirty,
    saving,
    save,
    confirmDiscard,
    hostRef
  }
}
