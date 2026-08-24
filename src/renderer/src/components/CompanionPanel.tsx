import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { CompanionInfo, PairingInfo } from '../../../shared/types'
import { useModalOverlay } from '../modal-overlay'

interface Props {
  onClose: () => void
}

/** What the phone reads out of the QR. Keep in step with the app's scanner. */
interface PairingPayload {
  v: 1
  host: string
  port: number
  code: string
}

const AGO_UNITS: [number, string][] = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm']
]

function ago(at: number): string {
  const delta = Date.now() - at
  for (const [ms, unit] of AGO_UNITS) {
    if (delta >= ms) return `${Math.floor(delta / ms)}${unit} ago`
  }
  return 'just now'
}

/**
 * Pairing, as a panel rather than a dialog.
 *
 * It used to be two modal message boxes, which deadlocked: the box showing the
 * code blocked the window, so the confirmation behind it never appeared and
 * pairing never resolved. A panel also has room for a QR, which is the
 * difference between scanning and typing an address, a port and a code.
 */
export function CompanionPanel({ onClose }: Props): React.JSX.Element {
  const panelRef = useModalOverlay<HTMLDivElement>(onClose)
  const [info, setInfo] = useState<CompanionInfo | null>(null)
  const [offer, setOffer] = useState<PairingInfo | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [left, setLeft] = useState(0)

  const refresh = useCallback(async () => {
    setInfo(await window.claudeTerm.companionDevices())
  }, [])

  // A device pairing or dropping shows up here without any push from main, so
  // poll. The first read is a tick in so the effect body sets no state itself.
  useEffect(() => {
    let alive = true
    const read = async (): Promise<void> => {
      const next = await window.claudeTerm.companionDevices()
      if (alive) setInfo(next)
    }
    const timer = setInterval(() => void read(), 1500)
    const first = setTimeout(() => void read(), 0)
    return () => {
      alive = false
      clearInterval(timer)
      clearTimeout(first)
    }
  }, [])

  // Cancel an unused offer on the way out, so a code never outlives its panel.
  useEffect(() => {
    return () => {
      void window.claudeTerm.companionCancelOffer()
    }
  }, [])

  useEffect(() => {
    if (!offer) return
    const tick = (): void => setLeft(Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000)))
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 500)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [offer])

  const startPairing = async (): Promise<void> => {
    const next = await window.claudeTerm.companionOffer()
    setOffer(next)
    if (!next.host) {
      setQr(null)
      return
    }
    const payload: PairingPayload = {
      v: 1,
      host: next.host,
      port: next.port,
      code: next.code
    }
    setQr(
      await QRCode.toDataURL(JSON.stringify(payload), {
        margin: 1,
        width: 260,
        color: { dark: '#0b0d11', light: '#e9edf5' }
      })
    )
  }

  const expired = offer !== null && left === 0

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="activity-panel companion-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-head">
          <span className="activity-title">Phones</span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="companion-body">
          <section className="companion-pair">
            {!offer ? (
              <>
                <p className="companion-note">
                  A phone can follow these sessions, answer their prompts and send new ones. It is
                  reachable only over Tailscale — nothing on the local network can see it.
                </p>
                <button className="companion-cta" onClick={() => void startPairing()}>
                  Show a pairing code
                </button>
                {info && !info.host ? (
                  <p className="companion-warn">
                    No Tailscale address on this Mac, so only this machine can reach the companion.
                    Start Tailscale and try again.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                {qr ? (
                  <img className="companion-qr" src={qr} alt="Pairing QR code" />
                ) : (
                  <p className="companion-warn">
                    No Tailscale address, so there is nothing a phone could scan.
                  </p>
                )}
                <div className="companion-code">{offer.code}</div>
                <div className="companion-addr">
                  {offer.host ?? '127.0.0.1'} · port {offer.port}
                </div>
                <div className={`companion-timer ${expired ? 'expired' : ''}`}>
                  {expired ? 'expired' : `valid for ${left}s`}
                </div>
                <button className="companion-cta" onClick={() => void startPairing()}>
                  {expired ? 'New code' : 'Start over'}
                </button>
                <p className="companion-note">
                  Scan it, or type the code into the app. It pairs one device and then stops
                  working.
                </p>
              </>
            )}
          </section>

          <section className="companion-devices">
            <div className="companion-devices-head">
              <span>Paired</span>
              <span className="companion-connected">
                {info ? `${info.connected} connected` : ''}
              </span>
            </div>
            {info && info.devices.length === 0 ? (
              <p className="companion-note">No phones paired yet.</p>
            ) : null}
            {info?.devices.map((device) => (
              <div key={device.deviceId} className="companion-device">
                <div className="companion-device-name">
                  <span>{device.name}</span>
                  <span className="companion-device-seen">seen {ago(device.lastSeen)}</span>
                </div>
                <button
                  className="companion-revoke"
                  onClick={() => {
                    void window.claudeTerm.companionRevoke(device.deviceId).then(() => refresh())
                  }}
                  title="Disconnect it and require pairing again"
                >
                  Revoke
                </button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
