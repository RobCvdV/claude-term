import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocEntry, DocGroup, DocTarget, ProjectDocs, TreeNode } from '../../../shared/types'
import { MAX_EDIT_BYTES } from '../../../shared/types'
import { MARKDOWN_LANG } from '../monaco-setup'
import { languageForFile } from '../config-lang'
import { attachSpellcheck } from '../spell'
import { attachGrammar } from '../grammar'
import { useFileEditor } from '../file-editor'
import { formatBytes } from '../format'
import { FileTree } from './FileTree'

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

/** One selectable file in the rail, whatever listing it came from: a plan, a
 *  doc, a configuration file, or a file picked out of the tree. */
export interface FileItem {
  path: string
  /** what the rail shows — a doc's title, a config file's relative path */
  label: string
  size: number
}

/** A labelled run of files in the rail. */
interface RailGroup {
  name: string
  /** shown under the heading when a group's root isn't the tab's own cwd */
  subtitle?: string
  items: FileItem[]
}

const docItems = (entries: DocEntry[]): FileItem[] =>
  entries.map((e) => ({ path: e.path, label: e.title, size: e.size }))

/** The rail's groups, in order: the curated markdown first, then the project's
 *  configuration files. The tree below them reaches everything else. */
function railGroups(d: ProjectDocs): RailGroup[] {
  const groups: RailGroup[] = [
    { name: 'Plan', items: docItems(d.plans) },
    { name: 'Roadmap', items: docItems(d.roadmap ? [d.roadmap] : []) },
    ...d.sections.map((s) => ({ name: s.name, items: docItems(s.entries) })),
    // the first config section is the tab's own root; later ones are added
    // directories (and the app's own pattern list), so they name themselves
    ...d.config.map((s, i) => ({
      name: i === 0 ? 'Settings' : `Settings · ${s.name}`,
      subtitle: s.subtitle,
      items: s.entries.map((e) => ({ path: e.path, label: e.rel, size: e.size }))
    }))
  ]
  return groups.filter((g) => g.items.length)
}

/** Where a landing group starts, falling back through the others so a window
 *  opened on an empty group still shows something. */
function pickInitial(d: ProjectDocs, group: DocGroup): FileItem | null {
  const first = (name: DocGroup): FileItem | null => {
    if (name === 'plan') return docItems(d.plans)[0] ?? null
    if (name === 'roadmap') return docItems(d.roadmap ? [d.roadmap] : [])[0] ?? null
    if (name === 'docs') return docItems(d.sections[0]?.entries ?? [])[0] ?? null
    const e = d.config[0]?.entries[0]
    return e ? { path: e.path, label: e.rel, size: e.size } : null
  }
  for (const name of [group, 'plan', 'roadmap', 'docs', 'settings'] as DocGroup[]) {
    const hit = first(name)
    if (hit) return hit
  }
  return null
}

/** The file a target points at: its listed entry, else a stand-in built from the
 *  file name — a file deeper than the listings reach is opened all the same. */
function targetEntry(d: ProjectDocs, target?: DocTarget | null): FileItem | null {
  if (!target) return null
  const hit = railGroups(d)
    .flatMap((g) => g.items)
    .find((e) => e.path === target.path)
  if (hit) return hit
  const name = target.path.split('/').pop() ?? target.path
  // size 0: a target is a file the app just created, never something to gate
  return { path: target.path, label: name.replace(/\.md$/i, ''), size: 0 }
}

export function DocsView({ tabId, group, target }: Props): React.JSX.Element {
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
  const patternsFile = docs?.patternsFile

  // markdown opens in its rendered preview; anything else has nothing to render,
  // so it opens in the editor — which is what the settings window always did
  const modeFor = (path: string): 'view' | 'edit' =>
    languageForFile(path) === MARKDOWN_LANG ? 'view' : 'edit'

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
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (!live) return
      setDocs(d)
      const initial = targetEntry(d, target) ?? pickInitial(d, group)
      editor.select(initial)
      if (target) setMode(target.edit ? 'edit' : 'view')
      else if (initial) setMode(modeFor(initial.path))
      openAtEnd.current = !!target?.edit
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
    editor.select({ path: node.path, label: node.name, size: node.size })
    setMode(modeFor(node.path))
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
    const q = filter.trim().toLowerCase()
    if (!q) return railGroups(docs)
    return railGroups(docs)
      .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length)
  }, [docs, filter])

  const listed = docs ? railGroups(docs).reduce((n, g) => n + g.items.length, 0) : 0
  const empty = !docs || (!listed && !docs.roots.length)

  const selectFile = (e: FileItem): void => {
    if (e.path === selected?.path || !editor.confirmDiscard()) return
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
          {selected && (
            <div className="docs-actions">
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
            <p className="activity-empty">Nothing to show for this project.</p>
          ) : (
            <>
              <div className="docs-rail">
                {listed > 0 && (
                  <input
                    className="config-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={`Filter ${listed} listed…`}
                    spellCheck={false}
                  />
                )}
                {groups.map(section)}
                {!!filter && !groups.length && <p className="activity-empty">No match.</p>}
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
