import { useEffect, useMemo, useState } from 'react'
import type { DocEntry, DocGroup, ProjectDocs } from '../../../shared/types'

interface Props {
  tabId: string
  /** which label was clicked — the overlay opens focused on that section */
  initialGroup: DocGroup
  onClose: () => void
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

export function DocsOverlay({ tabId, initialGroup, onClose }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [selected, setSelected] = useState<DocEntry | null>(null)
  // keyed to its path so a stale doc never shows while the next one loads
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (!live) return
      setDocs(d)
      setSelected(pickInitial(d, initialGroup))
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tabId, initialGroup])

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

  // Escape closes; the overlay is modal so it holds focus off the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rendered = useMemo(() => (content ? renderMarkdown(content) : ''), [content])

  const onPreviewClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.open(href)
  }

  const empty = !docs || (!docs.plans.length && !docs.roadmap && !docs.docs.length)

  const section = (label: string, entries: DocEntry[]): React.JSX.Element | null =>
    entries.length ? (
      <div className="docs-section" key={label}>
        <div className="docs-section-title">{label}</div>
        {entries.map((e) => (
          <button
            key={e.path}
            className={`docs-item ${selected?.path === e.path ? 'active' : ''}`}
            onClick={() => setSelected(e)}
            title={e.path}
          >
            {e.title}
          </button>
        ))}
      </div>
    ) : null

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div className="docs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <span className="activity-title">{selected?.title ?? 'Docs'}</span>
          {selected && (
            <button
              className="docs-open"
              onClick={() => window.claudeTerm.openDoc(tabId, selected.path)}
              title="Open in default app for editing"
            >
              Open ↗
            </button>
          )}
          <button className="activity-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
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
              <div className="docs-preview" onClick={onPreviewClick}>
                {content == null ? (
                  <p className="activity-empty">Loading…</p>
                ) : (
                  <div dangerouslySetInnerHTML={{ __html: rendered }} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
