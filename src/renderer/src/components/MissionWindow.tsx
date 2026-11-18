import { useEffect } from 'react'
import { WINDOW_KIND } from '../../../shared/window-titles'
import { useMissionTabs } from '../use-mission-tabs'
import { MissionControl } from './MissionControl'

/** Top-level component for the Mission control window: the tabs of every
 *  terminal window, kept live from main. */
export function MissionWindow(): React.JSX.Element {
  const { tabs, activeId, statuses, colors } = useMissionTabs()

  useEffect(() => {
    document.title = WINDOW_KIND.mission
  }, [])

  // ⌘E closes it again, as it does from a terminal window; ⇧⌘E opens the Work board
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'e') return
      e.preventDefault()
      if (e.shiftKey) window.claudeTerm.toggleBoard()
      else window.claudeTerm.toggleMission()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <MissionControl
      tabs={tabs}
      statuses={statuses}
      colors={colors}
      activeId={activeId}
      onSelectTab={(tabId) => window.claudeTerm.activateGlobalTab(tabId)}
    />
  )
}
