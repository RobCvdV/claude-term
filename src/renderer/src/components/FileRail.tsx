import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitMarks, ProjectDocs, RailAction, TreeNode } from '../../../shared/types'
import { markFor } from '../../../shared/git-marks'
import { matchesFilter } from '../../../shared/glob-match'
import { railGroups, type FileItem } from '../docs-rail'
import { iconFor } from '../file-icons'
import {
  ancestorsIn,
  buildRows,
  filterRows,
  firstStop,
  groupId,
  isOpenable,
  jump,
  left,
  pasteDir,
  QUICK,
  quickId,
  right,
  rowName,
  rowPath,
  step,
  type RailRow
} from '../file-rail-model'

/** The filter box searches the project on a pause in typing — the rail's own
 *  items filter as you type, since they are already here. */
const FIND_DEBOUNCE_MS = 160
/** Type-to-jump forgets what was typed after this long without a key. */
const TYPEAHEAD_MS = 1000
const NOTICE_MS = 3000
const PAGE = 10
const CLIP_ECHO_MS = 500
const STEP = 12
const WIDTH_KEY = 'fileRail.width'
const MIN_WIDTH = 180
const DEFAULT_WIDTH = 280

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A file to select in the rail and scroll to — `n` makes a repeat a change. */
export interface RevealRequest {
  path: string
  /** look in the project trees first, else in Quick Access first */
  prefer: 'tree' | 'quick'
  n: number
}

interface Props {
  tabId: string
  docs: ProjectDocs
  selectedPath?: string
  /** open a file; `focusEditor` hands the keyboard to the editor */
  onOpen: (item: FileItem, focusEditor: boolean) => void
  /** bumped whenever files may have changed on disk (a save, a new file) */
  refresh: number
  reveal: RevealRequest | null
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n >= MIN_WIDTH ? n : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

const itemOf = (row: RailRow): FileItem | null => {
  if (row.kind === 'item') return row.item
  if (row.kind === 'file') return { path: row.node.path, label: row.node.name, size: row.node.size }
  return null
}

const FolderIcon = ({ open }: { open: boolean }): React.JSX.Element => (
  <svg className="rail-icon folder" viewBox="0 0 16 16" aria-hidden>
    {open ? (
      <path d="M1.5 3.5h4l1.5 1.5h6.5v2H4.2L2 12.5h-.5zM4.2 7h11l-2.4 5.5H2z" />
    ) : (
      <path d="M1.5 3h4.2l1.5 1.5h7.3v8H1.5z" />
    )}
  </svg>
)

const PlainIcon = (): React.JSX.Element => (
  <svg className="rail-icon plain" viewBox="0 0 16 16" aria-hidden>
    <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" />
  </svg>
)

const GearIcon = ({ color }: { color: string }): React.JSX.Element => (
  <svg className="rail-icon" viewBox="0 0 16 16" aria-hidden style={{ color }}>
    <path
      fill="currentColor"
      d="M7 1h2l.3 1.8 1.2.5 1.5-1 1.4 1.4-1 1.5.5 1.2L15 7v2l-1.8.3-.5 1.2 1 1.5-1.4 1.4-1.5-1-1.2.5L9 15H7l-.3-1.8-1.2-.5-1.5 1-1.4-1.4 1-1.5-.5-1.2L1 9V7l1.8-.3.5-1.2-1-1.5 1.4-1.4 1.5 1 1.2-.5zM8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"
    />
  </svg>
)

function FileIcon({ name }: { name: string }): React.JSX.Element {
  const icon = iconFor(name)
  if (!icon) return <PlainIcon />
  if (!icon.text) return <GearIcon color={icon.color} />
  return (
    <span className="rail-badge" style={{ color: icon.color }}>
      {icon.text}
    </span>
  )
}

/**
 * The file window's left rail: Quick Access (plans, docs, settings) above a
 * tree per project folder, all driven from the keyboard as well as the mouse.
 * Rows are one flat list (see file-rail-model) so the keys walk exactly what
 * is on screen.
 */
export function FileRail({
  tabId,
  docs,
  selectedPath,
  onOpen,
  refresh,
  reveal
}: Props): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(() => new Set([QUICK]))
  const [entries, setEntries] = useState<Map<string, TreeNode[]>>(new Map())
  const [marks, setMarks] = useState<GitMarks | null>(null)
  const [filter, setFilter] = useState('')
  const [found, setFound] = useState<{ query: string; hits: TreeNode[] } | null>(null)
  // one cursor per mode, so clearing the filter goes back to where you were
  const [treeCursor, setTreeCursor] = useState<string | null>(null)
  const [findCursor, setFindCursor] = useState<string | null>(null)
  const [width, setWidth] = useState(readWidth)
  const [notice, setNotice] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typed = useRef<{ text: string; timer?: ReturnType<typeof setTimeout> }>({ text: '' })
  // the file Quick Look is showing, if any
  const quickLook = useRef<string | null>(null)
  // when the keys last copied or pasted, so the Edit menu's echo of the same
  // press is not run a second time
  const clipKeyAt = useRef(-Infinity)
  // the latest state for callbacks that outlive a render (focus, IPC replies)
  const openRef = useRef(open)
  const entriesRef = useRef(entries)
  useEffect(() => {
    openRef.current = open
    entriesRef.current = entries
  }, [open, entries])

  const filtering = !!filter.trim()

  const load = useCallback(
    (dir: string): Promise<void> =>
      window.claudeTerm.listDocTree(tabId, dir).then((nodes) => {
        setEntries((prev) => new Map(prev).set(dir, nodes))
      }),
    [tabId]
  )

  const loadMarks = useCallback(() => {
    void window.claudeTerm.docsGitMarks(tabId).then(setMarks)
  }, [tabId])

  // project folders start open; one added later (an /add-dir) opens too
  const seenRoots = useRef(new Set<string>())
  useEffect(() => {
    const fresh = docs.roots.filter((r) => !seenRoots.current.has(r.path))
    if (!fresh.length) return
    for (const r of fresh) seenRoots.current.add(r.path)
    setOpen((prev) => new Set([...prev, ...fresh.map((r) => r.path)]))
    for (const r of fresh) void load(r.path)
  }, [docs.roots, load])

  // Re-read what is on screen: Claude, git or Finder may have changed it. A
  // closed folder's listing is dropped rather than re-read.
  const reload = useCallback(() => {
    const dirs = [...entriesRef.current.keys()]
    setEntries((prev) => {
      const next = new Map(prev)
      for (const dir of dirs) if (!openRef.current.has(dir)) next.delete(dir)
      return next
    })
    for (const dir of dirs) if (openRef.current.has(dir)) void load(dir)
    loadMarks()
  }, [load, loadMarks])

  useEffect(() => {
    reload()
  }, [refresh, reload])

  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  const groups = useMemo(() => railGroups(docs), [docs])
  const shownGroups = useMemo(() => {
    if (!filtering) return groups
    return groups
      .map((g) => ({
        ...g,
        // a doc is listed under its heading ("Fixture"), so match its file name
        // too — `*.md` is about the file, not the title above it
        items: g.items.filter(
          (i) => matchesFilter(filter, i.label) || matchesFilter(filter, fileName(i.path))
        )
      }))
      .filter((g) => g.items.length)
  }, [groups, filter, filtering])

  // …and searches the project for anything Quick Access doesn't list
  useEffect(() => {
    if (!filtering) return
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
  }, [tabId, filter, filtering, refresh])

  const elsewhere = useMemo((): FileItem[] => {
    if (!found || found.query !== filter) return []
    const listed = new Set(shownGroups.flatMap((g) => g.items.map((i) => i.path)))
    return found.hits
      .filter((f) => !listed.has(f.path))
      .map((f) => ({ path: f.path, label: f.name, size: f.size }))
  }, [found, filter, shownGroups])

  const rows = useMemo(
    () =>
      filtering
        ? filterRows(shownGroups, elsewhere)
        : buildRows({ groups, roots: docs.roots, entries, open }),
    [filtering, shownGroups, elsewhere, groups, docs.roots, entries, open]
  )
  // a new search starts on its first hit
  const cursor = filtering
    ? rows.some((r) => r.id === findCursor)
      ? findCursor
      : firstStop(rows)
    : treeCursor
  const setCursor = filtering ? setFindCursor : setTreeCursor
  const rowById = (id: string | null): RailRow | undefined =>
    id === null ? undefined : rows.find((r) => r.id === id)

  const dirty = useMemo(() => new Set(marks?.dirty ?? []), [marks])

  useEffect(() => {
    if (!cursor || !listRef.current) return
    listRef.current
      .querySelector(`[data-id="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, rows])

  const flash = (text: string): void => setNotice(text)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  const setOpenState = (id: string, want: boolean): void => {
    setOpen((prev) => {
      if (prev.has(id) === want) return prev
      const next = new Set(prev)
      if (want) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const expand = (row: RailRow): void => {
    setOpenState(row.id, true)
    const dir = row.kind === 'dir' ? row.node.path : row.kind === 'header' ? row.dir : undefined
    if (dir && !entriesRef.current.has(dir)) void load(dir)
  }

  const toggle = (row: RailRow): void => {
    if (!isOpenable(row)) return
    if (row.open) setOpenState(row.id, false)
    else expand(row)
  }

  /** Show `path` in the rail: open what it sits in and put the cursor on it. */
  const revealPath = useCallback(
    async (path: string, prefer: 'tree' | 'quick'): Promise<void> => {
      const inTree = async (): Promise<boolean> => {
        const root = docs.roots.find((r) => path.startsWith(r.path + '/'))
        if (!root) return false
        const dirs = ancestorsIn(root.path, path)
        await Promise.all(dirs.filter((d) => !entriesRef.current.has(d)).map(load))
        setOpen((prev) => new Set([...prev, ...dirs]))
        setTreeCursor(path)
        return true
      }
      const inQuick = (): boolean => {
        const g = groups.find((g) => g.items.some((i) => i.path === path))
        if (!g) return false
        setOpen((prev) => new Set([...prev, QUICK, groupId(g.name)]))
        setTreeCursor(quickId(path))
        return true
      }
      setFilter('')
      if (prefer === 'tree') {
        if (!(await inTree())) inQuick()
      } else if (!inQuick()) await inTree()
    },
    [docs.roots, groups, load]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a reveal is a request from the owner; the tree state it opens is ours
    if (reveal) void revealPath(reveal.path, reveal.prefer)
    // a new request is a new `n`; the path and preference come with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n])

  const focusSearch = (): void => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }
  const focusList = (): void => {
    if (!rowById(cursor)) setCursor(firstStop(rows))
    listRef.current?.focus()
  }

  const locate = (): void => {
    if (!selectedPath) return
    void revealPath(selectedPath, 'tree').then(() => listRef.current?.focus())
  }

  // ⇧⌘F, ⌘L and ⌥⌘L from anywhere in the window, the editor included; plain ⌘F
  // only outside the editor, which has a find of its own
  const keysRef = useRef({ focusSearch, locate, focusList })
  useEffect(() => {
    keysRef.current = { focusSearch, locate, focusList }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey) return
      const inEditor = !!(e.target as Element | null)?.closest?.('.monaco-editor')
      if (e.code === 'KeyF' && !e.altKey && (e.shiftKey || !inEditor)) {
        e.preventDefault()
        e.stopPropagation()
        keysRef.current.focusSearch()
      } else if (e.code === 'KeyL' && e.altKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        keysRef.current.locate()
      } else if (e.code === 'KeyL' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        keysRef.current.focusList()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const activate = (row: RailRow, focusEditor: boolean): void => {
    const item = itemOf(row)
    if (item) onOpen(item, focusEditor)
    else toggle(row)
  }

  const setQuickLook = (path: string | null): void => {
    quickLook.current = path
    void window.claudeTerm.docsQuickLook(tabId, path)
  }

  // the panel closes itself (its own Space/Esc, a click away) without telling us
  useEffect(() => {
    const forget = (): void => {
      quickLook.current = null
    }
    window.addEventListener('focus', forget)
    return () => window.removeEventListener('focus', forget)
  }, [])

  const paste = async (row: RailRow): Promise<void> => {
    const dir = pasteDir(row)
    if (!dir) {
      flash('Paste into a project folder — Quick Access is only a listing')
      return
    }
    const result = await window.claudeTerm.docsPaste(tabId, dir)
    if (!result.ok) {
      flash(result.error)
      return
    }
    if (!openRef.current.has(dir)) setOpenState(dir, true)
    await load(dir)
    loadMarks()
    setTreeCursor(result.paths[0])
    flash(
      result.paths.length === 1
        ? `Pasted ${fileName(result.paths[0])}`
        : `Pasted ${result.paths.length} items`
    )
  }

  const copy = async (row: RailRow): Promise<void> => {
    const path = rowPath(row)
    if (path && (await window.claudeTerm.docsCopyFile(tabId, path)))
      flash(`Copied ${fileName(path)}`)
  }

  const copyPath = (row: RailRow): void => {
    const path = rowPath(row)
    if (!path) return
    void navigator.clipboard.writeText(path)
    flash('Copied path')
  }

  const run = (action: RailAction, row: RailRow): void => {
    const path = rowPath(row)
    if (!path) return
    switch (action) {
      case 'open':
        return activate(row, true)
      case 'openDefault':
        void window.claudeTerm.openDoc(tabId, path)
        return
      case 'quickLook':
        return setQuickLook(path)
      case 'reveal':
        void window.claudeTerm.revealDoc(tabId, path)
        return
      case 'copy':
        void copy(row)
        return
      case 'copyPath':
        return copyPath(row)
      case 'paste':
        void paste(row)
        return
    }
  }

  const showMenu = async (row: RailRow, at?: { x: number; y: number }): Promise<void> => {
    const path = rowPath(row)
    if (!path) return
    let point = at
    if (!point) {
      const el = listRef.current?.querySelector(`[data-id="${CSS.escape(row.id)}"]`)
      const rect = el?.getBoundingClientRect()
      point = rect ? { x: rect.left + 24, y: rect.bottom } : { x: 0, y: 0 }
    }
    const action = await window.claudeTerm.docsRailMenu({
      path,
      isDir: row.kind === 'dir' || row.kind === 'header',
      inTree: pasteDir(row) !== undefined,
      ...point
    })
    if (action) run(action, row)
  }

  const typeAhead = (ch: string): void => {
    const t = typed.current
    const fresh = !t.text
    t.text += ch
    clearTimeout(t.timer)
    t.timer = setTimeout(() => (t.text = ''), TYPEAHEAD_MS)
    const hit = jump(rows, cursor, t.text, !fresh)
    if (hit) setCursor(hit)
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    const row = rowById(cursor)
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    const move = (delta: number): void => {
      e.preventDefault()
      const next = step(rows, cursor, delta)
      if (next) setCursor(next)
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Space') {
      e.preventDefault()
      if (row) void showMenu(row)
      return
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyO') {
      e.preventDefault()
      const item = row && itemOf(row)
      if (item) void window.claudeTerm.openDoc(tabId, item.path)
      return
    }
    if (e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyC') {
      e.preventDefault()
      if (row) copyPath(row)
      return
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
      e.preventDefault()
      clipKeyAt.current = e.timeStamp
      if (row) void (e.code === 'KeyC' ? copy(row) : paste(row))
      return
    }
    if (!plain) return
    switch (e.key) {
      case 'ArrowDown':
        return move(1)
      case 'ArrowUp':
        if (cursor === firstStop(rows)) {
          e.preventDefault()
          return focusSearch()
        }
        return move(-1)
      case 'PageDown':
        return move(PAGE)
      case 'PageUp':
        return move(-PAGE)
      case 'Home':
        return move(-Infinity)
      case 'End':
        return move(Infinity)
      case 'ArrowRight': {
        e.preventDefault()
        if (!row) return
        const r = right(rows, row.id)
        if (r.open) expand(row)
        if (r.cursor) setCursor(r.cursor)
        return
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (!row) return
        const l = left(rows, row.id)
        if (l.close) setOpenState(l.close, false)
        if (l.cursor) setCursor(l.cursor)
        return
      }
      case 'Enter':
        e.preventDefault()
        if (row) activate(row, true)
        return
      case 'Escape':
        e.preventDefault()
        if (quickLook.current) setQuickLook(null)
        else focusSearch()
        return
      case 'ContextMenu':
        e.preventDefault()
        if (row) void showMenu(row)
        return
    }
    if (e.key.length !== 1) return
    e.preventDefault()
    // Space is Quick Look, unless it continues a name being typed
    if (e.key === ' ' && !typed.current.text) {
      const item = row && itemOf(row)
      // Space again on the previewed file closes it; on another file, previews that
      setQuickLook(!item || quickLook.current === item.path ? null : item.path)
      return
    }
    typeAhead(e.key)
  }

  const onSearchKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusList()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rowById(cursor) ?? rowById(firstStop(rows))
      if (row) activate(row, true)
    } else if (e.key === 'Escape' && filter) {
      e.preventDefault()
      setFilter('')
    }
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    // the shown width, which max-width may have capped below `width`
    const startW = e.currentTarget.parentElement!.getBoundingClientRect().width
    let last = startW
    const onMove = (m: MouseEvent): void => {
      const max = Math.max(MIN_WIDTH, window.innerWidth * 0.6)
      last = Math.min(max, Math.max(MIN_WIDTH, startW + m.clientX - startX))
      setWidth(last)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('rail-resizing')
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(last)))
      } catch {
        // storage blocked — the width just isn't remembered
      }
    }
    document.body.classList.add('rail-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const renderRow = (row: RailRow): React.JSX.Element => {
    const path = rowPath(row)
    const isDir = row.kind === 'dir' || row.kind === 'header'
    const mark = path ? markFor(marks, dirty, path, isDir) : undefined
    const excluded = (row.kind === 'dir' || row.kind === 'file') && row.excluded
    const active = !!path && !isDir && path === selectedPath
    const classes = [
      'rail-row',
      `rail-${row.kind}`,
      row.id === cursor ? 'cursor' : '',
      active ? 'active' : '',
      excluded ? 'excluded' : mark ? `vcs-${mark}` : ''
    ]
    if (row.kind === 'note' || row.kind === 'label') {
      return (
        <div
          key={row.id}
          className={classes.join(' ')}
          style={{ paddingLeft: 6 + row.depth * STEP }}
        >
          {row.kind === 'note' ? row.text : row.label}
        </div>
      )
    }
    const openable = isOpenable(row)
    const title =
      row.kind === 'header'
        ? row.title
        : row.kind === 'group'
          ? row.subtitle
          : excluded
            ? `${path} — excluded (dependencies or build output)`
            : path
    return (
      <div
        key={row.id}
        data-id={row.id}
        role="treeitem"
        aria-expanded={openable ? row.open : undefined}
        aria-selected={row.id === cursor}
        className={classes.join(' ')}
        style={{ paddingLeft: 6 + row.depth * STEP }}
        title={title}
        onClick={() => {
          setCursor(row.id)
          activate(row, false)
          listRef.current?.focus()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCursor(row.id)
          void showMenu(row, { x: e.clientX, y: e.clientY })
        }}
      >
        <span className={`rail-twisty ${openable && row.open ? 'open' : ''}`}>
          {openable && (
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M3.5 2l3 3-3 3" />
            </svg>
          )}
        </span>
        {row.kind === 'dir' && <FolderIcon open={row.open} />}
        {(row.kind === 'file' || row.kind === 'item') && <FileIcon name={fileName(path!)} />}
        <span className="rail-name">{rowName(row)}</span>
        {row.kind === 'group' && row.subtitle && <span className="rail-sub">{row.subtitle}</span>}
      </div>
    )
  }

  const noMatch = filtering && !rows.some((r) => r.kind === 'item')

  return (
    <div className="file-rail" style={{ width }}>
      <div className="rail-search">
        <input
          ref={searchRef}
          className="config-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Find a file — * allowed"
          spellCheck={false}
          autoFocus
        />
        <button
          className="rail-locate"
          onClick={locate}
          disabled={!selectedPath}
          title="Select the open file in the tree (⌥⌘L)"
        >
          ◎
        </button>
      </div>
      <div
        ref={listRef}
        className="rail-list"
        role="tree"
        tabIndex={0}
        onKeyDown={onListKey}
        onCopy={(e) => {
          const row = rowById(cursor)
          if (!row || !rowPath(row)) return
          e.preventDefault()
          if (e.timeStamp - clipKeyAt.current < CLIP_ECHO_MS) return
          void copy(row)
        }}
        onPaste={(e) => {
          const row = rowById(cursor)
          if (!row) return
          e.preventDefault()
          if (e.timeStamp - clipKeyAt.current < CLIP_ECHO_MS) return
          void paste(row)
        }}
      >
        {rows.map(renderRow)}
        {noMatch && <p className="activity-empty">No file matches.</p>}
      </div>
      {notice && <div className="rail-notice">{notice}</div>}
      <div className="rail-resize" onMouseDown={startResize} title="Drag to resize" />
    </div>
  )
}
