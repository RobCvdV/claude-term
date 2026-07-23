import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { DocEntry, DocGroup, ProjectDocs } from '../../../shared/types'
import { MARKDOWN_LANG, setupMonaco } from '../monaco-setup'

interface Props {
  tabId: string
  /** which section to focus — changes when the owner tab re-opens the window */
  group: DocGroup
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline spans on already-HTML-escaped text: code, bold, italic, links. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, href) => `<a href="${href}">${t}</a>`)
}

/** A small, dependency-free markdown → HTML renderer good enough for previews:
 *  headings, fenced code, lists, blockquotes, rules, and paragraphs. Input is
 *  HTML-escaped before any markup is added, so raw HTML in the file is inert. */
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      closeList()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // skip closing fence
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      html.push(`<h${h[1].length}>${inline(escapeHtml(h[2].trim()))}</h${h[1].length}>`)
      i++
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList()
      html.push('<hr />')
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      closeList()
      const buf: string[] = []
      while (i < lines.length) {
        const m = /^>\s?(.*)$/.exec(lines[i])
        if (!m) break
        buf.push(inline(escapeHtml(m[1])))
        i++
      }
      html.push(`<blockquote>${buf.join('<br />')}</blockquote>`)
      continue
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (listType !== 'ul') {
        closeList()
        html.push('<ul>')
        listType = 'ul'
      }
      html.push(`<li>${inline(escapeHtml(ul[1]))}</li>`)
      i++
      continue
    }

    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (listType !== 'ol') {
        closeList()
        html.push('<ol>')
        listType = 'ol'
      }
      html.push(`<li>${inline(escapeHtml(ol[1]))}</li>`)
      i++
      continue
    }

    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }

    // paragraph — gather consecutive plain lines
    closeList()
    const buf: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s|^```|^>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(inline(escapeHtml(lines[i])))
      i++
    }
    html.push(`<p>${buf.join('<br />')}</p>`)
  }
  closeList()
  return html.join('\n')
}

/** First entry of the requested group, falling back through the others. */
function pickInitial(d: ProjectDocs, group: DocGroup): DocEntry | null {
  const order: DocGroup[] = [group, 'plan', 'roadmap', 'docs']
  for (const g of order) {
    if (g === 'plan' && d.plans[0]) return d.plans[0]
    if (g === 'roadmap' && d.roadmap) return d.roadmap
    if (g === 'docs' && d.docs[0]) return d.docs[0]
  }
  return null
}

export function DocsView({ tabId, group }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [selected, setSelected] = useState<DocEntry | null>(null)
  // keyed to its path so a stale doc never shows while the next one loads
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  // the editor's working copy; null until editing starts for the current doc
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (!live) return
      setDocs(d)
      setSelected(pickInitial(d, group))
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tabId, group])

  useEffect(() => {
    if (!selected) return
    let live = true
    window.claudeTerm.readDoc(tabId, selected.path).then((c) => {
      if (live) setLoaded({ path: selected.path, text: c })
    })
    return () => {
      live = false
    }
  }, [tabId, selected])

  const content = selected && loaded?.path === selected.path ? loaded.text : null
  // what the view/editor shows: the unsaved draft when present, else disk content
  const shown = draft ?? content
  const dirty = draft != null && draft !== content

  const save = useCallback(async (): Promise<void> => {
    if (!selected || draft == null) return
    setSaving(true)
    const ok = await window.claudeTerm.writeDoc(tabId, selected.path, draft)
    setSaving(false)
    // reconcile the baseline so `dirty` clears; editor is not recreated
    if (ok) setLoaded({ path: selected.path, text: draft })
  }, [tabId, selected, draft])

  // Monaco's Cmd+S command is bound once per editor, so reach the latest `save`
  // (which closes over the current draft) through a ref kept fresh in an effect.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  // Let the main process know whether there are unsaved edits, so closing the
  // window (or its tab) can prompt to save/discard first.
  useEffect(() => {
    window.claudeTerm.docsDirty(dirty)
  }, [dirty])

  // Honour a "save before closing" request from the main process.
  useEffect(() => {
    return window.claudeTerm.onDocsRequestSave(() => {
      void saveRef.current().finally(() => window.claudeTerm.docsSaveDone())
    })
  }, [])

  // Monaco editor lifecycle — mounted only while editing the current doc.
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
  useEffect(() => {
    if (mode !== 'edit' || !selected || content == null || !hostRef.current) return
    const monaco = setupMonaco()
    const uri = monaco.Uri.parse(`claude-doc://${selected.path}`)
    const model =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(draft ?? content, MARKDOWN_LANG, uri)
    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: 'claude-term',
      automaticLayout: true,
      wordWrap: 'on',
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none'
    })
    editorRef.current = editor
    const sub = editor.onDidChangeModelContent(() => setDraft(editor.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
    editor.focus()
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // recreate only when entering edit mode or switching docs — not on every
    // content/draft change (those flow FROM the editor). `content` is read once
    // here; the Edit toggle is disabled until it has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected?.path])

  const confirmDiscard = useCallback((): boolean => {
    return !dirty || window.confirm('Discard unsaved changes?')
  }, [dirty])

  const rendered = useMemo(() => (shown ? renderMarkdown(shown) : ''), [shown])

  const onPreviewClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.open(href)
  }

  const empty = !docs || (!docs.plans.length && !docs.roadmap && !docs.docs.length)

  const selectDoc = (e: DocEntry): void => {
    if (e.path === selected?.path || !confirmDiscard()) return
    // switching docs drops any draft and returns to view
    setSelected(e)
    setMode('view')
    setDraft(null)
  }

  const section = (label: string, entries: DocEntry[]): React.JSX.Element | null =>
    entries.length ? (
      <div className="docs-section" key={label}>
        <div className="docs-section-title">{label}</div>
        {entries.map((e) => (
          <button
            key={e.path}
            className={`docs-item ${selected?.path === e.path ? 'active' : ''}`}
            onClick={() => selectDoc(e)}
            title={e.path}
          >
            {e.title}
          </button>
        ))}
      </div>
    ) : null

  return (
    <div className="docs-window">
      <div className="docs-panel">
        <div className="activity-head">
          <span className="activity-title">
            {selected?.title ?? 'Docs'}
            {dirty && (
              <span className="docs-dirty" title="Unsaved changes">
                {' '}
                ●
              </span>
            )}
          </span>
          {selected && (
            <div className="docs-actions">
              {dirty && (
                <button
                  className="docs-btn docs-save"
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              <button
                className="docs-btn"
                onClick={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
                disabled={content == null}
                title={
                  mode === 'edit' ? 'Preview the rendered markdown' : 'Edit the markdown source'
                }
              >
                {mode === 'edit' ? 'View' : 'Edit'}
              </button>
              <button
                className="docs-btn"
                onClick={() => window.claudeTerm.openDoc(tabId, selected.path)}
                title="Open in default app for editing"
              >
                Open ↗
              </button>
            </div>
          )}
        </div>

        <div className="docs-body">
          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : empty ? (
            <p className="activity-empty">No plan, roadmap or docs for this project.</p>
          ) : (
            <>
              <div className="docs-rail">
                {section('Plan', docs!.plans)}
                {section('Roadmap', docs!.roadmap ? [docs!.roadmap] : [])}
                {section('Docs', docs!.docs)}
              </div>
              {mode === 'edit' ? (
                <div className="docs-editor" ref={hostRef} />
              ) : (
                <div className="docs-preview" onClick={onPreviewClick}>
                  {shown == null ? (
                    <p className="activity-empty">Loading…</p>
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
