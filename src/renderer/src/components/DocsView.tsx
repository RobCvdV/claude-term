import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocEntry, DocGroup, DocTarget, ProjectDocs } from '../../../shared/types'
import { MARKDOWN_LANG } from '../monaco-setup'
import { languageForFile } from '../config-lang'
import { attachSpellcheck } from '../spell'
import { attachGrammar } from '../grammar'
import { useFileEditor } from '../file-editor'

interface Props {
  tabId: string
  /** which section to focus — changes when the owner tab re-opens the window */
  group: DocGroup
  /** one specific doc to open (a just-created `/add-file`), instead of the
   *  group's first entry — with `edit` it opens straight in the editor */
  target?: DocTarget | null
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
    if (g === 'docs' && d.sections[0]?.entries[0]) return d.sections[0].entries[0]
  }
  return null
}

/** Every listed doc, in rail order. */
function allEntries(d: ProjectDocs): DocEntry[] {
  return [...d.plans, ...(d.roadmap ? [d.roadmap] : []), ...d.sections.flatMap((s) => s.entries)]
}

/** The doc a target points at: its listed entry, else a stand-in built from the
 *  file name — docs more than one folder deep exist but aren't in the rail. */
function targetEntry(d: ProjectDocs, target?: DocTarget | null): DocEntry | null {
  if (!target) return null
  const hit = allEntries(d).find((e) => e.path === target.path)
  if (hit) return hit
  const name = target.path.split('/').pop() ?? target.path
  return { path: target.path, title: name.replace(/\.md$/i, ''), mtime: 0 }
}

export function DocsView({ tabId, group, target }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  // a doc handed to us for editing (/add-file) starts with the cursor at the
  // end, under its seeded heading; consumed by the editor on mount, so a later
  // View→Edit toggle still opens at the top like any other doc
  const openAtEnd = useRef(false)

  const editor = useFileEditor<DocEntry>({
    io: {
      read: (path) => window.claudeTerm.readDoc(tabId, path),
      write: (path, content) => window.claudeTerm.writeDoc(tabId, path, content),
      reportDirty: (d) => window.claudeTerm.docsDirty(d),
      onRequestSave: (cb) => window.claudeTerm.onDocsRequestSave(cb),
      saveDone: () => window.claudeTerm.docsSaveDone()
    },
    scheme: 'claude-doc',
    editing: mode === 'edit',
    options: { wordWrap: 'on', renderWhitespace: 'none' },
    attach: (ed, language) => {
      if (openAtEnd.current) {
        openAtEnd.current = false
        const model = ed.getModel()
        if (model) ed.setPosition(model.getFullModelRange().getEndPosition())
      }
      // prose only: spelling and grammar on code or config would be all noise,
      // and their quick fixes are registered for markdown anyway
      if (language !== MARKDOWN_LANG) return []
      return [attachSpellcheck(ed, 'markdown'), attachGrammar(ed)]
    }
  })
  const { selected, content, shown, dirty, saving, save, hostRef } = editor

  useEffect(() => {
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (!live) return
      setDocs(d)
      editor.select(targetEntry(d, target) ?? pickInitial(d, group))
      if (target) setMode(target.edit ? 'edit' : 'view')
      openAtEnd.current = !!target?.edit
      setLoading(false)
    })
    return () => {
      live = false
    }
    // a re-target is only ever a new path/mode, so depend on those, not identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, group, target?.path, target?.edit])

  // only markdown gets rendered; any other file (a .gitignore, a script) is
  // shown as-is, since the markdown renderer would mangle it
  const isMarkdown = !selected || languageForFile(selected.path) === MARKDOWN_LANG
  const rendered = useMemo(() => (shown ? renderMarkdown(shown) : ''), [shown])

  const onPreviewClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.open(href)
  }

  const empty = !docs || (!docs.plans.length && !docs.roadmap && !docs.sections.length)

  const selectDoc = (e: DocEntry): void => {
    if (e.path === selected?.path || !editor.confirmDiscard()) return
    // switching docs drops any draft (the hook's job) and returns to view
    editor.select(e)
    setMode('view')
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
                title={mode === 'edit' ? 'Preview this file' : 'Edit this file'}
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
                {docs!.sections.map((s) => section(s.name, s.entries))}
              </div>
              {mode === 'edit' ? (
                <div className="docs-editor" ref={hostRef} />
              ) : (
                <div className="docs-preview" onClick={onPreviewClick}>
                  {shown == null ? (
                    <p className="activity-empty">Loading…</p>
                  ) : isMarkdown ? (
                    <div dangerouslySetInnerHTML={{ __html: rendered }} />
                  ) : (
                    <pre>
                      <code>{shown}</code>
                    </pre>
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
