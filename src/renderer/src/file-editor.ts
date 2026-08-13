import { useCallback, useEffect, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import { setupMonaco } from './monaco-setup'
import { languageForFile } from './config-lang'
import { contentOf, isDirty, keepsDraft, reselect, shownText } from './file-editor-state'
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
}

export function useFileEditor<E extends { path: string }>(spec: FileEditorSpec<E>): FileEditor<E> {
  const { io, scheme, editing } = spec
  const [selected, setSelected] = useState<E | null>(null)
  const [loaded, setLoaded] = useState<LoadedFile | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The spec the effects below read. Held in a ref (synced after each render,
  // before any other effect runs) so a caller passing fresh closures every
  // render can't remount the editor or re-read the file.
  const specRef = useRef(spec)
  useEffect(() => {
    specRef.current = spec
  })

  // the open path, for select()/reselect() — they must not depend on a render
  const openPath = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!selected) return
    if (specRef.current.readable && !specRef.current.readable(selected)) return
    let live = true
    void specRef.current.io.read(selected.path).then((text) => {
      if (live) setLoaded({ path: selected.path, text })
    })
    return () => {
      live = false
    }
  }, [selected])

  const content = contentOf(loaded, selected?.path)
  const shown = shownText(draft, content)
  const dirty = isDirty(draft, content)

  const select = useCallback((entry: E | null): void => {
    // a draft belongs to the file it was typed in — never carry it to another
    if (!keepsDraft(openPath.current, entry?.path)) setDraft(null)
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
  const contentReady = content != null
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
      ...specRef.current.options
    })
    const subs = [
      editor.onDidChangeModelContent(() => setDraft(editor.getValue())),
      ...(specRef.current.attach?.(editor, language) ?? [])
    ]
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
    editor.focus()
    return () => {
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

  return {
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
