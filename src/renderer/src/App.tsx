import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../shared/types'
import { TabBar } from './components/TabBar'
import { TerminalPane } from './components/TerminalPane'
import { StatusBar } from './components/StatusBar'
import { PromptBox, PromptBoxHandle } from './components/PromptBox'
import { disposeTerm, focusTerm, setTerminalEscapeHandler } from './term-registry'

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<TabId | null>(null)
  const [statuses, setStatuses] = useState<Record<TabId, TabStatus | null>>({})
  const promptRefs = useRef(new Map<TabId, PromptBoxHandle>())

  useEffect(() => {
    return window.claudeTerm.onStatusUpdate((status) => {
      setStatuses((prev) => ({ ...prev, [status.tabId]: status }))
    })
  }, [])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses

  // a dialog (permission prompt / question picker) appeared: give the active
  // tab's terminal keyboard focus so arrows+Enter work immediately.
  // Background tabs only get their attention dot — never steal focus across tabs.
  useEffect(() => {
    return window.claudeTerm.onAttention((tabId) => {
      if (tabId === activeIdRef.current) focusTerm(tabId)
    })
  }, [])

  // on tab switch, put focus where it's most useful: a tab with a pending
  // dialog gets the terminal (answer it now — this also covers a background
  // tab that raised a dialog while unfocused); any other tab gets the prompt
  // box, ready to type.
  useEffect(() => {
    if (!activeId) return
    const raf = requestAnimationFrame(() => {
      if (statusesRef.current[activeId]?.activity === 'needs-attention') {
        focusTerm(activeId)
      } else {
        promptRefs.current.get(activeId)?.focus()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [activeId])

  // when a tab settles back to idle (Stop hook: a response, dialog, or other
  // terminal interaction just finished), return focus to the active tab's
  // prompt box — no more ⌘K to get back. Fires only on the transition into
  // idle (git/statusline updates re-send the same activity and are ignored),
  // and only for the active tab.
  const prevActivityRef = useRef<Record<TabId, ActivityState>>({})
  useEffect(() => {
    for (const [tabId, status] of Object.entries(statuses)) {
      const cur = status?.activity
      if (!cur) continue
      const prev = prevActivityRef.current[tabId]
      if (cur === prev) continue
      prevActivityRef.current[tabId] = cur
      if (cur === 'idle' && prev && prev !== 'idle' && tabId === activeIdRef.current) {
        promptRefs.current.get(tabId)?.focus()
      }
    }
  }, [statuses])

  // Esc in the terminal: overlays with no turn (e.g. /usage, /config, /help)
  // close on Esc but fire no Stop hook, so refocus-on-idle can't help. The Esc
  // is forwarded to the PTY (closing the overlay); here we hand focus back to
  // the box — but only when idle, so Esc used to interrupt a response (busy) or
  // cancel a dialog (needs-attention) is left to those flows.
  useEffect(() => {
    setTerminalEscapeHandler((tabId) => {
      if (tabId !== activeIdRef.current) return
      const activity = statusesRef.current[tabId]?.activity
      if (activity === 'busy' || activity === 'needs-attention') return
      promptRefs.current.get(tabId)?.focus()
    })
  }, [])

  const openTab = useCallback(async (cwd: string): Promise<void> => {
    const tab = await window.claudeTerm.createTab(cwd)
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.tabId)
    const snapshot = await window.claudeTerm.statusSnapshot(tab.tabId)
    setStatuses((prev) => ({ ...prev, [tab.tabId]: snapshot }))
  }, [])

  const newTab = useCallback(async (): Promise<void> => {
    const cwd = await window.claudeTerm.pickFolder()
    if (cwd) await openTab(cwd)
  }, [openTab])

  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current) return
    autoOpened.current = true
    void window.claudeTerm.initialCwd().then((cwd) => {
      if (cwd) void openTab(cwd)
    })
    // scripted E2E aid: open a tab in a given cwd, bypassing the folder picker
    ;(window as unknown as Record<string, unknown>).__openTab = (cwd: string) => openTab(cwd)
  }, [openTab])

  const closeTab = useCallback(
    (tabId: TabId): void => {
      const status = statuses[tabId]
      if (
        status?.activity === 'busy' &&
        !window.confirm('This session is still working. Close it?')
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
      promptRefs.current.delete(tabId)
    },
    [statuses]
  )

  const renameTab = useCallback((tabId: TabId, title: string): void => {
    setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, title } : t)))
  }, [])

  const restartTab = useCallback((tabId: TabId, resume: boolean): void => {
    void window.claudeTerm.restartTab(tabId, resume)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 't') {
        e.preventDefault()
        void newTab()
      } else if (e.key === 'w') {
        e.preventDefault()
        if (activeId) closeTab(activeId)
      } else if (e.key === 'k') {
        e.preventDefault()
        if (activeId) promptRefs.current.get(activeId)?.focus()
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
  }, [tabs, activeId, newTab, closeTab])

  const activeStatus = activeId ? (statuses[activeId] ?? null) : null

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        statuses={statuses}
        onSelect={setActiveId}
        onClose={closeTab}
        onNewTab={() => void newTab()}
        onRename={renameTab}
      />
      {tabs.length === 0 ? (
        <div className="empty-state">
          <p>No sessions.</p>
          <button onClick={() => void newTab()}>Open a project folder (⌘T)</button>
        </div>
      ) : (
        <>
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.tabId}
              tabId={tab.tabId}
              active={tab.tabId === activeId}
              status={statuses[tab.tabId] ?? null}
              onRestart={(resume) => restartTab(tab.tabId, resume)}
              onClose={() => closeTab(tab.tabId)}
            />
          ))}
          <StatusBar status={activeStatus} />
          {tabs.map((tab) => (
            <div key={tab.tabId} style={{ display: tab.tabId === activeId ? 'block' : 'none' }}>
              <PromptBox
                ref={(h) => {
                  if (h) promptRefs.current.set(tab.tabId, h)
                }}
                tabId={tab.tabId}
                disabled={['exited', 'ended'].includes(statuses[tab.tabId]?.activity ?? '')}
              />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
