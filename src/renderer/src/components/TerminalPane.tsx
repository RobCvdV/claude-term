import { useEffect, useRef } from 'react'
import type { TabId, TabStatus } from '../../../shared/types'
import { createTerm, fitTerm } from '../term-registry'

interface Props {
  tabId: TabId
  active: boolean
  status: TabStatus | null
  onRestart: (resume: boolean) => void
  onClose: () => void
}

export function TerminalPane({ tabId, active, status, onRestart, onClose }: Props): React.JSX.Element {
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
    const host = hostRef.current
    const observer = new ResizeObserver(() => fitTerm(tabId))
    if (host) observer.observe(host)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [tabId, active])

  const exited = status?.activity === 'exited'

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="exit-overlay">
          <span>
            claude exited{status?.exitCode !== null ? ` (code ${status?.exitCode})` : ''}
          </span>
          <button onClick={() => onRestart(false)}>Restart</button>
          {status?.sessionId && <button onClick={() => onRestart(true)}>Resume session</button>}
          <button onClick={onClose}>Close tab</button>
        </div>
      )}
    </div>
  )
}
