import { useEffect, useMemo, useRef, useState } from 'react'
import type { MissionTabs, TabId, TabStatus } from '../../shared/types'

/** Every terminal window's tabs with their live status, for the app-wide
 *  panels (Mission control, Work board). */
export function useMissionTabs(): MissionTabs & {
  statuses: Record<TabId, TabStatus | null>
  colors: Record<TabId, string>
} {
  const [state, setState] = useState<MissionTabs>({ tabs: [], activeId: null })
  const [statuses, setStatuses] = useState<Record<TabId, TabStatus | null>>({})
  const asked = useRef(new Set<TabId>())

  useEffect(() => {
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

  const colors = useMemo(
    () =>
      Object.fromEntries(
        state.tabs.filter((t) => t.color).map((t) => [t.tabId, t.color as string])
      ),
    [state.tabs]
  )

  return { ...state, statuses, colors }
}
