import { useEffect, useRef } from 'react'
import type { TabId, TabStatus } from '../../../shared/types'
import { createTerm, fitTerm } from '../term-registry'
import { FindBar } from './FindBar'

interface Props {
  tabId: TabId
  active: boolean
  status: TabStatus | null
  /** >0 = search bar open; bumped on every ⌘F to refocus its input */
  searchNonce: number
  onCloseSearch: () => void
  onRestart: () => void
  onClose: () => void
}

/** how long the size must hold still before the terminal follows it */
const FIT_SETTLE_MS = 80

export function TerminalPane({
  tabId,
  active,
  status,
  searchNonce,
  onCloseSearch,
  onRestart,
  onClose
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const entry = createTerm(tabId)
    host.appendChild(entry.containerEl)
    return () => {
      // keep the container (and terminal state) alive for tab switches;
      // disposal happens explicitly on tab close in App
      if (entry.containerEl.parentElement === host) host.removeChild(entry.containerEl)
    }
  }, [tabId])

  useEffect(() => {
    if (!active) return
    // fit only once visible; rAF lets the display change land first.
    // Focus is owned by App (it decides terminal vs prompt box on tab switch).
    const raf = requestAnimationFrame(() => fitTerm(tabId))
    // a burst of sizes (a display waking, a window dragged) is one resize, and
    // one back to where it was is none: Claude Code redraws on every resize
    let timer = 0
    const refit = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => fitTerm(tabId), FIT_SETTLE_MS)
    }
    const host = hostRef.current
    const observer = new ResizeObserver(refit)
    if (host) observer.observe(host)
    document.addEventListener('visibilitychange', refit)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', refit)
    }
  }, [tabId, active])

  const exited = status?.activity === 'exited'

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-host" ref={hostRef} />
      <FindBar
        tabId={tabId}
        canSearchConvo={Boolean(status?.claudeActive && status.sessionId)}
        open={searchNonce > 0}
        focusNonce={searchNonce}
        onClose={onCloseSearch}
      />
      {exited && (
        <div className="exit-overlay">
          <span>
            terminal exited{status?.exitCode !== null ? ` (code ${status?.exitCode})` : ''}
          </span>
          <button onClick={onRestart}>New shell</button>
          <button onClick={onClose}>Close tab</button>
        </div>
      )}
    </div>
  )
}
