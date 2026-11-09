import { useEffect, useMemo, useRef, useState } from 'react'
import type { MissionTabs, TabId, TabStatus } from '../../../shared/types'
import { WINDOW_KIND } from '../../../shared/window-titles'
import { MissionControl } from './MissionControl'

/** Top-level component for the Mission control window: the tabs of every
 *  terminal window, kept live from main. */
export function MissionWindow(): React.JSX.Element {
  const [state, setState] = useState<MissionTabs>({ tabs: [], activeId: null })
  const [statuses, setStatuses] = useState<Record<TabId, TabStatus | null>>({})
  const asked = useRef(new Set<TabId>())

  useEffect(() => {
    document.title = WINDOW_KIND.mission
    void window.claudeTerm.missionTabs().then(setState)
    const offTabs = window.claudeTerm.onMissionTabs(setState)
    const offStatus = window.claudeTerm.onStatusUpdate((st) =>
      setStatuses((prev) => ({ ...prev, [st.tabId]: st }))
    )
    return () => {
      offTabs()
      offStatus()
    }
  }, [])

  // updates only come on a change — a tab seen for the first time needs its latest
  useEffect(() => {
    for (const { tabId } of state.tabs) {
      if (asked.current.has(tabId)) continue
      asked.current.add(tabId)
      void window.claudeTerm.statusSnapshot(tabId).then((st) => {
        if (st) setStatuses((prev) => (prev[tabId] ? prev : { ...prev, [tabId]: st }))
      })
    }
  }, [state.tabs])

  // ⌘E closes it again, as it does from a terminal window
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'e') {
        e.preventDefault()
        window.claudeTerm.toggleMission()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const colors = useMemo(
    () =>
      Object.fromEntries(
        state.tabs.filter((t) => t.color).map((t) => [t.tabId, t.color as string])
      ),
    [state.tabs]
  )

  return (
    <MissionControl
      tabs={state.tabs}
      statuses={statuses}
      colors={colors}
      activeId={state.activeId}
      onSelectTab={(tabId) => window.claudeTerm.activateGlobalTab(tabId)}
    />
  )
}
