import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityState,
  DocGroup,
  PersistedSession,
  TabId,
  TabInfo,
  TabStatus
} from '../../shared/types'
import { TabBar } from './components/TabBar'
import { TerminalPane } from './components/TerminalPane'
import { StatusBar } from './components/StatusBar'
import { PromptBox, PromptBoxHandle } from './components/PromptBox'
import { ActivityOverview } from './components/ActivityOverview'
import { DocsOverlay } from './components/DocsOverlay'
import {
  disposeTerm,
  focusTerm,
  setTerminalEscapeHandler,
  setTerminalTitleHandler
} from './term-registry'

// Turn a dropped NON-image file's path into the text submitted to claude: an
// @-mention (@relative inside the cwd, @absolute otherwise) — the form Claude
// Code parses to reference/attach the file. A path with whitespace can't ride
// an @-mention (parsing stops at the space), so it falls back to a quoted path
// Claude reads with its own tools.
function promptTokenForPath(path: string, cwd?: string): string {
  if (/\s/.test(path)) return `"${path}"`
  const rel =
    cwd && path.startsWith(cwd.replace(/\/+$/, '') + '/')
      ? path.slice(cwd.replace(/\/+$/, '').length + 1)
      : null
  return `@${rel ?? path}`
}

// Images take a different route than @-mentions: Claude Code auto-detects an
// absolute image path in pasted input and turns it into its own [Image #N]
// attachment, reading the bytes itself. We mirror exactly what a native macOS
// terminal drag inserts — the absolute path with shell-special chars (spaces
// included) backslash-escaped — so that detector fires the same way.
function imageMentionForPath(path: string): string {
  return path.replace(/[^A-Za-z0-9_\-./]/g, (c) => `\\${c}`)
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?|avif|ico)$/i
function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path)
}

// plain-terminal drops mimic a normal terminal: type the shell-escaped path
function shellEscape(path: string): string {
  return /[^A-Za-z0-9_\-./]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path
}

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<TabId | null>(null)
  const [statuses, setStatuses] = useState<Record<TabId, TabStatus | null>>({})
  const [colors, setColors] = useState<Record<TabId, string>>({})
  const [dropTarget, setDropTarget] = useState<'prompt' | 'terminal' | null>(null)
  const [showActivity, setShowActivity] = useState(false)
  const [docsGroup, setDocsGroup] = useState<DocGroup | null>(null)
  const promptRefs = useRef(new Map<TabId, PromptBoxHandle>())
  const manualTitles = useRef(new Set<TabId>())

  useEffect(() => {
    return window.claudeTerm.onStatusUpdate((status) => {
      setStatuses((prev) => ({ ...prev, [status.tabId]: status }))
    })
  }, [])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // exposed for scripted E2E testing (CDP) — harmless at runtime
  ;(window as unknown as Record<string, unknown>).__activeTabId = activeId
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  // gate persistence until the initial restore finishes, so an early save can't
  // clobber the saved session with an empty/partial tab list
  const restoredRef = useRef(false)

  const focusBox = (tabId: TabId): void => {
    requestAnimationFrame(() => promptRefs.current.get(tabId)?.focus())
  }

  // Put focus where it's most useful for the tab's current state: an active
  // claude session with no pending dialog → prompt box; a dialog the user must
  // drive (needs-attention) or a plain terminal → the terminal. Used after a
  // modal overlay closes so focus never gets stranded on the dismissed dialog.
  const restoreFocus = (tabId: TabId): void => {
    requestAnimationFrame(() => {
      const st = statusesRef.current[tabId]
      if (st?.claudeActive && st.activity !== 'needs-attention') {
        promptRefs.current.get(tabId)?.focus()
      } else {
        focusTerm(tabId)
      }
    })
  }

  // a dialog (permission prompt / question picker) appeared: focus the active
  // tab's terminal so arrows+Enter work immediately. Never steal across tabs.
  useEffect(() => {
    return window.claudeTerm.onAttention((tabId) => {
      if (tabId === activeIdRef.current) focusTerm(tabId)
    })
  }, [])

  // plain terminals: adopt the shell's OSC title unless the user renamed the tab.
  // Strip any leading status emoji (e.g. "🟢 claude-term · main") — our own tab
  // dot already conveys activity, so the emoji would just be a redundant dot.
  useEffect(() => {
    setTerminalTitleHandler((tabId, title) => {
      if (manualTitles.current.has(tabId)) return
      const clean = title.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim()
      setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, title: clean || title } : t)))
    })
  }, [])

  // on tab switch, put focus where it's most useful: a claude session with a
  // pending dialog → terminal; an active claude session → prompt box; a plain
  // terminal (no session) → terminal.
  useEffect(() => {
    if (!activeId) return
    const raf = requestAnimationFrame(() => {
      const st = statusesRef.current[activeId]
      if (st?.claudeActive && st.activity !== 'needs-attention') {
        promptRefs.current.get(activeId)?.focus()
      } else {
        focusTerm(activeId)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [activeId])

  // React to claude session start/stop and turn completion on the active tab.
  const prevActivityRef = useRef<Record<TabId, ActivityState>>({})
  const prevClaudeRef = useRef<Record<TabId, boolean>>({})
  useEffect(() => {
    for (const [tabId, status] of Object.entries(statuses)) {
      if (!status) continue
      const isActive = tabId === activeIdRef.current

      // claude session appeared → focus the box; ended → back to the terminal
      const prevClaude = prevClaudeRef.current[tabId]
      if (status.claudeActive !== prevClaude) {
        prevClaudeRef.current[tabId] = status.claudeActive
        if (isActive) {
          if (status.claudeActive) focusBox(tabId)
          else focusTerm(tabId)
        }
      }

      // Return focus to the prompt box either when the turn finishes (busy →
      // idle) OR the instant a dialog is answered and work resumes
      // (needs-attention → busy). The terminal only holds focus while a dialog
      // is actually waiting, so the box is focused the rest of the time.
      const cur = status.activity
      const prev = prevActivityRef.current[tabId]
      if (cur !== prev) {
        prevActivityRef.current[tabId] = cur
        const turnFinished = cur === 'idle' && prev && prev !== 'idle'
        const dialogAnswered = prev === 'needs-attention' && cur === 'busy'
        if (status.claudeActive && isActive && (turnFinished || dialogAnswered)) {
          promptRefs.current.get(tabId)?.focus()
        }
      }
    }
  }, [statuses])

  // Esc in the terminal dismisses a client-side overlay (/usage, /config, …) and
  // should hand focus back to the box. We can't gate on 'idle': those commands
  // fire UserPromptSubmit (→busy) but run no model turn, so no Stop ever arrives
  // and the tab stays 'busy' — the old idle-only guard left focus stranded on
  // the terminal. Only a real dialog (needs-attention) keeps focus there. The
  // delay lets the overlay finish closing and lets a rapid double-Esc still land
  // in the terminal before we take focus.
  useEffect(() => {
    setTerminalEscapeHandler((tabId) => {
      if (tabId !== activeIdRef.current) return
      const st = statusesRef.current[tabId]
      if (!st?.claudeActive || st.activity === 'needs-attention') return
      setTimeout(() => {
        if (activeIdRef.current !== tabId) return
        const cur = statusesRef.current[tabId]
        if (!cur?.claudeActive || cur.activity === 'needs-attention') return
        promptRefs.current.get(tabId)?.focus()
      }, 120)
    })
  }, [])

  // File drag & drop, window-wide (capture phase beats Monaco's and xterm's own
  // DnD handling, and preventDefault stops Chromium navigating to file:// URLs).
  // With a claude session: insert prompt tokens into the box. Plain terminal:
  // type the shell-escaped path, like dropping onto a normal terminal.
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      const st = activeIdRef.current ? statusesRef.current[activeIdRef.current] : null
      setDropTarget(st?.claudeActive ? 'prompt' : 'terminal')
    }
    const onDragLeave = (e: DragEvent): void => {
      // relatedTarget is null when the drag exits the window
      if (!e.relatedTarget) setDropTarget(null)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      const tabId = activeIdRef.current
      if (!tabId) return
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.claudeTerm.pathForFile(f))
        .filter(Boolean)
      if (paths.length === 0) return
      const st = statusesRef.current[tabId]
      if (st?.claudeActive) {
        const items = paths.map((p) => {
          const isImage = isImagePath(p)
          return {
            mention: isImage ? imageMentionForPath(p) : promptTokenForPath(p, st.cwd),
            isImage
          }
        })
        promptRefs.current.get(tabId)?.insertAttachments(items)
      } else {
        window.claudeTerm.ptyInput(tabId, paths.map(shellEscape).join(' '))
        focusTerm(tabId)
      }
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])

  const openTab = useCallback(async (cwd?: string): Promise<void> => {
    const tab = await window.claudeTerm.createTab(cwd)
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.tabId)
    const snapshot = await window.claudeTerm.statusSnapshot(tab.tabId)
    setStatuses((prev) => ({ ...prev, [tab.tabId]: snapshot }))
  }, [])

  // ⌘T opens a plain terminal in the home dir; ⌘O opens one in a chosen folder.
  const newTab = useCallback((): void => void openTab(), [openTab])
  const openFolder = useCallback(async (): Promise<void> => {
    const cwd = await window.claudeTerm.pickFolder()
    if (cwd) await openTab(cwd)
  }, [openTab])

  // Recreate the saved tabs (in order), resuming any that had a live claude
  // session. Colors/titles/active tab are restored too.
  const restoreSession = useCallback(async (saved: PersistedSession): Promise<void> => {
    const created: TabInfo[] = []
    const colorInit: Record<TabId, string> = {}
    const statusInit: Record<TabId, TabStatus | null> = {}
    for (const t of saved.tabs) {
      const resume = t.claudeActive && t.sessionId ? t.sessionId : undefined
      const tab = await window.claudeTerm.createTab(t.cwd, resume)
      created.push({ ...tab, title: t.title || tab.title })
      if (t.manualTitle) manualTitles.current.add(tab.tabId)
      if (t.color) colorInit[tab.tabId] = t.color
      statusInit[tab.tabId] = await window.claudeTerm.statusSnapshot(tab.tabId)
    }
    setTabs(created)
    setColors((prev) => ({ ...prev, ...colorInit }))
    setStatuses((prev) => ({ ...prev, ...statusInit }))
    const active = created[saved.activeIndex] ?? created[0]
    if (active) setActiveId(active.tabId)
  }, [])

  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current) return
    autoOpened.current = true
    ;(window as unknown as Record<string, unknown>).__openTab = (cwd?: string) => openTab(cwd)
    void (async () => {
      // dev override wins; otherwise restore the saved session; otherwise home
      const initial = await window.claudeTerm.initialCwd()
      if (initial) {
        await openTab(initial)
      } else {
        const saved = await window.claudeTerm.loadSession()
        if (saved && saved.tabs.length > 0) await restoreSession(saved)
        else await openTab()
      }
      restoredRef.current = true
    })()
  }, [openTab, restoreSession])

  // Assemble the current session for persistence (reads refs so it's stable).
  const buildPersisted = useCallback(
    (): PersistedSession => ({
      tabs: tabsRef.current.map((t) => {
        const st = statusesRef.current[t.tabId]
        return {
          cwd: st?.cwd || t.cwd,
          title: t.title,
          manualTitle: manualTitles.current.has(t.tabId),
          color: colorsRef.current[t.tabId],
          sessionId: st?.sessionId ?? null,
          claudeActive: !!st?.claudeActive
        }
      }),
      activeIndex: Math.max(
        0,
        tabsRef.current.findIndex((t) => t.tabId === activeIdRef.current)
      )
    }),
    []
  )

  // debounced save on any change to the persisted-relevant state
  useEffect(() => {
    if (!restoredRef.current) return
    const id = setTimeout(() => void window.claudeTerm.saveSession(buildPersisted()), 400)
    return () => clearTimeout(id)
  }, [tabs, statuses, colors, activeId, buildPersisted])

  // guarantee the final state is written on quit/reload (async save may not run)
  useEffect(() => {
    const flush = (): void => {
      if (restoredRef.current) window.claudeTerm.saveSessionSync(buildPersisted())
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [buildPersisted])

  const closeTab = useCallback(
    (tabId: TabId): void => {
      const status = statuses[tabId]
      if (
        status?.activity === 'busy' &&
        !window.confirm('A claude session is still working. Close this tab?')
      ) {
        return
      }
      void window.claudeTerm.closeTab(tabId)
      disposeTerm(tabId)
      setTabs((prev) => {
        const next = prev.filter((t) => t.tabId !== tabId)
        setActiveId((current) => {
          if (current !== tabId) return current
          const idx = prev.findIndex((t) => t.tabId === tabId)
          return next[Math.min(idx, next.length - 1)]?.tabId ?? null
        })
        return next
      })
      setStatuses((prev) => {
        const rest = { ...prev }
        delete rest[tabId]
        return rest
      })
      setColors((prev) => {
        const rest = { ...prev }
        delete rest[tabId]
        return rest
      })
      promptRefs.current.delete(tabId)
      manualTitles.current.delete(tabId)
    },
    [statuses]
  )

  const renameTab = useCallback((tabId: TabId, title: string): void => {
    manualTitles.current.add(tabId)
    setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, title } : t)))
  }, [])

  const restartTab = useCallback((tabId: TabId): void => {
    void window.claudeTerm.restartTab(tabId)
  }, [])

  // /color <name|#hex|off> from the prompt box tints this tab's accent border.
  const setTabColor = useCallback((tabId: TabId, color: string): void => {
    const off = ['off', 'none', 'clear', 'reset', 'default'].includes(color)
    setColors((prev) => {
      const next = { ...prev }
      if (off) delete next[tabId]
      else next[tabId] = color
      return next
    })
  }, [])

  // step to the prev/next tab, wrapping around
  const stepTab = useCallback(
    (delta: number): void => {
      setActiveId((current) => {
        if (tabs.length === 0) return current
        const idx = tabs.findIndex((t) => t.tabId === current)
        return tabs[(idx + delta + tabs.length) % tabs.length]?.tabId ?? current
      })
    },
    [tabs]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 't') {
        e.preventDefault()
        newTab()
      } else if (e.key === 'o') {
        e.preventDefault()
        void openFolder()
      } else if (e.key === 'w') {
        e.preventDefault()
        if (activeId) closeTab(activeId)
      } else if (e.key === 'k') {
        e.preventDefault()
        if (activeId) promptRefs.current.get(activeId)?.focus()
      } else if (e.key === '[' || e.key === ']') {
        // ⌘[ / ⌘] walk through tabs (wraps around); ⌘←/⌘→ stay line-start/end
        if (tabs.length === 0) return
        e.preventDefault()
        stepTab(e.key === ']' ? 1 : -1)
      } else if (e.key >= '1' && e.key <= '9') {
        const tab = tabs[Number(e.key) - 1]
        if (tab) {
          e.preventDefault()
          setActiveId(tab.tabId)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tabs, activeId, newTab, openFolder, closeTab, stepTab])

  const activeStatus = activeId ? (statuses[activeId] ?? null) : null
  const showClaudeUi = !!activeStatus?.claudeActive

  // Fill the active tab's prompt (only if empty) — used by the worklog panel to
  // tee up "Log my hours" after preparing a dispatch.
  const fillPromptIfEmpty = useCallback(
    (text: string): void => {
      if (activeId) promptRefs.current.get(activeId)?.fillIfEmpty(text)
    },
    [activeId]
  )

  return (
    <div className="app">
      {dropTarget && (
        <div className="drop-overlay">
          {dropTarget === 'prompt' ? 'Drop to add file(s) to the prompt' : 'Drop to type path(s)'}
        </div>
      )}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        colors={colors}
        onSelect={setActiveId}
        onClose={closeTab}
        onNewTab={newTab}
        onRename={renameTab}
        onOpenActivity={() => setShowActivity(true)}
      />
      {showActivity && (
        <ActivityOverview onClose={() => setShowActivity(false)} onFillPrompt={fillPromptIfEmpty} />
      )}
      {tabs.length === 0 ? (
        <div className="empty-state">
          <p>No terminals open.</p>
          <button onClick={newTab}>New terminal (⌘T)</button>
        </div>
      ) : (
        <>
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.tabId}
              tabId={tab.tabId}
              active={tab.tabId === activeId}
              status={statuses[tab.tabId] ?? null}
              onRestart={() => restartTab(tab.tabId)}
              onClose={() => closeTab(tab.tabId)}
            />
          ))}
          {showClaudeUi && activeStatus && (
            <StatusBar
              status={activeStatus}
              color={activeId ? colors[activeId] : undefined}
              onOpenDocs={setDocsGroup}
            />
          )}
          {docsGroup && activeId && (
            <DocsOverlay
              tabId={activeId}
              initialGroup={docsGroup}
              onClose={() => {
                setDocsGroup(null)
                if (activeId) restoreFocus(activeId)
              }}
            />
          )}
          {showClaudeUi && activeId && (
            <PromptBox
              key={activeId}
              ref={(h) => {
                if (h) promptRefs.current.set(activeId, h)
              }}
              tabId={activeId}
              disabled={false}
              // focus on mount unless a dialog is waiting (that wants the terminal)
              autoFocus={activeStatus?.activity !== 'needs-attention'}
              onStepTab={stepTab}
              onColor={(color) => setTabColor(activeId, color)}
              color={colors[activeId]}
            />
          )}
        </>
      )}
    </div>
  )
}
