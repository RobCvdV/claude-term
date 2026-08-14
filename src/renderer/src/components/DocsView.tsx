import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocGroup, DocTarget, ProjectDocs, TreeNode } from '../../../shared/types'
import { MAX_EDIT_BYTES } from '../../../shared/types'
import { MARKDOWN_LANG } from '../monaco-setup'
import { languageForFile } from '../config-lang'
import { landingFor, modeFor, railGroups, type FileItem, type RailGroup } from '../docs-rail'
import { attachSpellcheck } from '../spell'
import { attachGrammar } from '../grammar'
import { useFileEditor } from '../file-editor'
import { formatBytes } from '../format'
import { FileTree } from './FileTree'
import { matchesFilter } from '../../../shared/glob-match'
import { revealLabel } from '../../../shared/reveal-label'

/** The filter box searches the project on a pause in typing — the rail's own
 *  items filter as you type, since they are already here. */
const FIND_DEBOUNCE_MS = 160

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

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

export function DocsView({ tabId, group, target, onOpenFile }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  // a doc handed to us for editing (/add-file) starts with the cursor at the
  // end, under its seeded heading; consumed by the editor on mount, so a later
  // View→Edit toggle still opens at the top like any other doc
  const openAtEnd = useRef(false)
  // expanded folders and the children read for them, for the file tree
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeEntries, setTreeEntries] = useState<Map<string, TreeNode[]>>(new Map())
  // files the user answered the size warning for ("Open anyway")
  const [oversizeOk, setOversizeOk] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  // bumped after saving the pattern list, which changes what settings lists
  const [rescan, setRescan] = useState(0)
  // a file this window just created: it wins the selection on the re-list that
  // follows, instead of the group's usual landing
  const justCreated = useRef<string | null>(null)
  const [newFileError, setNewFileError] = useState<string | null>(null)
  // files the filter box found in the project, tagged with the query they
  // answer so a stale result is never shown next to a newer one
  const [found, setFound] = useState<{ query: string; hits: TreeNode[] } | null>(null)
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
    readable: (e) => e.size <= MAX_EDIT_BYTES || oversizeOk.has(e.path),
    options: { wordWrap: 'on', renderWhitespace: 'none' },
    // the pattern list decides what the settings groups hold — re-list once saved
    onSaved: (e) => {
      if (e.path === patternsFile) setRescan((n) => n + 1)
    },
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
      setMode(landing.mode)
      openAtEnd.current = landing.atEnd
      setLoading(false)
    })
    return () => {
      live = false
    }
    // a re-target is only ever a new path/mode, so depend on those, not identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, group, target?.path, target?.edit, rescan])

  // Expanding a folder reads it once; collapsing keeps what was read, so
  // re-opening a branch is instant.
  const toggleFolder = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
    if (treeEntries.has(dir)) return
    void window.claudeTerm.listDocTree(tabId, dir).then((nodes) => {
      setTreeEntries((prev) => new Map(prev).set(dir, nodes))
    })
  }

  /** Open a file picked from the tree. It isn't in the rail's own listings, so
   *  it becomes an entry of its own, labelled by file name. */
  const openFromTree = (node: TreeNode): void => {
    if (node.path === selected?.path || !editor.confirmDiscard()) return
    setNewFileError(null)
    editor.select({ path: node.path, label: node.name, size: node.size })
    setMode(modeFor(node.path))
  }

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
    // the folder it landed in was read before the file existed
    const dir = made.path.replace(/\/[^/]*$/, '')
    setTreeEntries((prev) => {
      const next = new Map(prev)
      next.delete(dir)
      return next
    })
    if (expanded.has(dir)) {
      void window.claudeTerm
        .listDocTree(tabId, dir)
        .then((nodes) => setTreeEntries((prev) => new Map(prev).set(dir, nodes)))
    }
    setRescan((n) => n + 1)
  }

  const tooLarge = !!selected && selected.size > MAX_EDIT_BYTES && !oversizeOk.has(selected.path)
  const openAnyway = (): void => {
    if (selected) setOversizeOk((prev) => new Set(prev).add(selected.path))
  }

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

  const groups = useMemo(() => {
    if (!docs) return []
    if (!filter.trim()) return railGroups(docs)
    return railGroups(docs)
      .map((g) => ({
        ...g,
        // a doc is listed under its heading ("Fixture"), so match its file name
        // too — `*.md` is about the file, not the title above it
        items: g.items.filter(
          (i) => matchesFilter(filter, i.label) || matchesFilter(filter, fileName(i.path))
        )
      }))
      .filter((g) => g.items.length)
  }, [docs, filter])

  // …and searches the project for anything the rail doesn't list (a file with
  // no extension, a script, a lock file): those live only in the tree.
  useEffect(() => {
    if (!filter.trim()) return
    let live = true
    const timer = setTimeout(() => {
      void window.claudeTerm.findDocFiles(tabId, filter).then((hits) => {
        if (live) setFound({ query: filter, hits })
      })
    }, FIND_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [tabId, filter, rescan])

  // what the rail already shows doesn't need showing twice
  const listedPaths = useMemo(
    () => new Set(groups.flatMap((g) => g.items.map((i) => i.path))),
    [groups]
  )
  const elsewhere =
    found && found.query === filter ? found.hits.filter((f) => !listedPaths.has(f.path)) : []

  const listed = docs ? railGroups(docs).reduce((n, g) => n + g.items.length, 0) : 0
  const empty = !docs || (!listed && !docs.roots.length)

  const selectFile = (e: FileItem): void => {
    if (e.path === selected?.path || !editor.confirmDiscard()) return
    setNewFileError(null)
    // switching files drops any draft — the hook's job
    editor.select(e)
    setMode(modeFor(e.path))
  }

  const section = (g: RailGroup): React.JSX.Element => (
    <div className="docs-section" key={g.name}>
      <div className="docs-section-title" title={g.subtitle}>
        {g.name}
        {g.subtitle && <span className="config-section-sub">{g.subtitle}</span>}
      </div>
      {g.items.map((e) => (
        <button
          key={e.path}
          className={`docs-item ${selected?.path === e.path ? 'active' : ''}`}
          onClick={() => selectFile(e)}
          title={e.path}
        >
          {e.label}
        </button>
      ))}
    </div>
  )

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

        <div className="docs-body">
          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : empty ? (
            <p className="activity-empty">Nothing to show for this project.</p>
          ) : (
            <>
              <div className="docs-rail">
                {(listed > 0 || !!docs!.roots.length) && (
                  <input
                    className="config-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Find a file — * allowed"
                    spellCheck={false}
                  />
                )}
                {groups.map(section)}
                {!!elsewhere.length &&
                  section({
                    name: 'Elsewhere in the project',
                    items: elsewhere.map((f) => ({ path: f.path, label: f.name, size: f.size }))
                  })}
                {!!filter.trim() && !groups.length && !elsewhere.length && (
                  <p className="activity-empty">No file matches.</p>
                )}
                {!!docs!.roots.length && (
                  <FileTree
                    roots={docs!.roots}
                    entries={treeEntries}
                    expanded={expanded}
                    selectedPath={selected?.path}
                    onToggle={toggleFolder}
                    onOpen={openFromTree}
                  />
                )}
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
              ) : mode === 'edit' ? (
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
