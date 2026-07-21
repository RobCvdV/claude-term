import { useCallback, useEffect, useState } from 'react'
import type { VolumeOp, VolumeState } from '../../../shared/types'

function SpeakerIcon({ muted, pct }: { muted: boolean; pct: number }): React.JSX.Element {
  // waves scale with level: none when muted, one wave when quiet, two otherwise
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M17 9l6 6M23 9l-6 6" />
      ) : (
        <>
          {pct > 0 && <path d="M16 9a4 4 0 0 1 0 6" />}
          {pct >= 55 && <path d="M19 6.5a8 8 0 0 1 0 11" />}
        </>
      )}
    </svg>
  )
}

export function VolumeControl(): React.JSX.Element | null {
  const [vol, setVol] = useState<VolumeState | null>(null)

  const refresh = useCallback(() => {
    window.claudeTerm.volumeGet().then(setVol)
  }, [])

  useEffect(() => {
    refresh()
    // poll so external changes (hotkeys, vol.sh, menubar) show up here too
    const id = setInterval(refresh, 1500)
    return () => clearInterval(id)
  }, [refresh])

  if (!vol || !vol.available) return null

  const act = (op: VolumeOp) => (e: React.MouseEvent): void => {
    e.stopPropagation()
    window.claudeTerm.volumeSet(op).then(setVol)
  }

  const { pct, muted } = vol
  return (
    <span className={`volume ${muted ? 'muted' : ''}`}>
      <button className="vol-step" onClick={act('down')} title="Quieter (−10%)" aria-label="Quieter">
        −
      </button>
      <button
        className="vol-toggle"
        onClick={act('toggle')}
        title={muted ? 'Unmute notifications' : 'Mute notifications'}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        <SpeakerIcon muted={muted} pct={pct} />
        <span className="vol-pct">{muted ? 'muted' : `${pct}%`}</span>
      </button>
      <button className="vol-step" onClick={act('up')} title="Louder (+10%)" aria-label="Louder">
        +
      </button>
    </span>
  )
}
