import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../shared/types'
import { TabBar } from './components/TabBar'
import { TerminalPane } from './components/TerminalPane'
import { StatusBar } from './components/StatusBar'
import { PromptBox, PromptBoxHandle } from './components/PromptBox'
import {
  disposeTerm,
  focusTerm,
  setTerminalEscapeHandler,
  setTerminalTitleHandler
} from './term-registry'

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<TabId | null>(null)
  const [statuses, setStatuses] = useState<Record<TabId, TabStatus | null>>({})
  const [colors, setColors] = useState<Record<TabId, string>>({})
  const promptRefs = useRef(new Map<TabId, PromptBoxHandle>())
  const manualTitles = useRef(new Set<TabId>())

  useEffect(() => {
    return window.claudeTerm.onStatusUpdate((status) => {
      setStatuses((prev) => ({ ...prev, [status.tabId]: status }))
    })
  }, [])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses

  const focusBox = (tabId: TabId): void => {
    requestAnimationFrame(() => promptRefs.current.get(tabId)?.focus())
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

      // a claude turn finished (transition into idle) → return focus to the box
      const cur = status.activity
      const prev = prevActivityRef.current[tabId]
      if (cur !== prev) {
        prevActivityRef.current[tabId] = cur
        if (status.claudeActive && cur === 'idle' && prev && prev !== 'idle' && isActive) {
          promptRefs.current.get(tabId)?.focus()
        }
      }
    }
  }, [statuses])

  // Esc in the terminal closes an overlay (/usage, /config, …) that fires no
  // hook; forward it to the PTY and return focus to the box — only while a
  // claude session is idle (so shell Esc, interrupts, and dialogs are untouched).
  useEffect(() => {
    setTerminalEscapeHandler((tabId) => {
      if (tabId !== activeIdRef.current) return
      const st = statusesRef.current[tabId]
      if (!st?.claudeActive) return
      if (st.activity === 'busy' || st.activity === 'needs-attention') return
      promptRefs.current.get(tabId)?.focus()
    })
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

  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current) return
    autoOpened.current = true
    void window.claudeTerm.initialCwd().then((cwd) => openTab(cwd ?? undefined))
    ;(window as unknown as Record<string, unknown>).__openTab = (cwd?: string) => openTab(cwd)
  }, [openTab])

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
  const stepTab = useCallback((delta: number): void => {
    setActiveId((current) => {
      if (tabs.length === 0) return current
      const idx = tabs.findIndex((t) => t.tabId === current)
      return tabs[(idx + delta + tabs.length) % tabs.length]?.tabId ?? current
    })
  }, [tabs])

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

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        colors={colors}
        onSelect={setActiveId}
        onClose={closeTab}
        onNewTab={newTab}
        onRename={renameTab}
      />
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
            <StatusBar status={activeStatus} color={activeId ? colors[activeId] : undefined} />
          )}
          {showClaudeUi && activeId && (
            <PromptBox
              key={activeId}
              ref={(h) => {
                if (h) promptRefs.current.set(activeId, h)
              }}
              tabId={activeId}
              disabled={false}
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
