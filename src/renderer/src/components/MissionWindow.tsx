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
