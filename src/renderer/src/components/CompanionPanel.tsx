import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** Anything paired after this counts as "just now" — including a device
   *  re-pairing, which keeps its id and only gets a fresh pairedAt. */
  const [openedAt] = useState(() => Date.now())
  /** The code we have already replaced, so one expiry mints one new code. */
  const replaced = useRef<string | null>(null)

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

  const startPairing = useCallback(async (): Promise<void> => {
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
  }, [])

  // A code is what this panel is for, so show one at once rather than behind a
  // button — nobody opens it to admire the list of phones they already have.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the offer is fetched over IPC; the state lands after the await
    void startPairing()
  }, [startPairing])

  // An expired code is a dead end: the phone cannot pair with it and the panel
  // would just sit there showing it. Replace it as it lapses.
  useEffect(() => {
    if (!offer || left > 0 || replaced.current === offer.code) return
    replaced.current = offer.code
    void startPairing()
  }, [offer, left, startPairing])

  // Pairing is done the moment a device says so, and the panel then has nothing
  // left to offer — name the phone, then get out of the way.
  const paired = info?.devices.find((d) => d.pairedAt >= openedAt)?.name ?? null

  useEffect(() => {
    if (!paired) return
    const timer = setTimeout(onClose, 1400)
    return () => clearTimeout(timer)
  }, [paired, onClose])

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
            {paired ? (
              <p className="companion-paired">Paired “{paired}” ✓</p>
            ) : !offer ? (
              <p className="companion-note">Getting a code…</p>
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
                  {expired ? 'getting a new code…' : `valid for ${left}s`}
                </div>
                <button className="companion-cta" onClick={() => void startPairing()}>
                  New code
                </button>
                <p className="companion-note">
                  Scan it, or type the code into the app. It pairs one phone and then stops working;
                  a fresh one appears here as this lapses.
                </p>
                {info && !info.host ? (
                  <p className="companion-warn">
                    No Tailscale address on this Mac, so no phone can reach it. Start Tailscale and
                    press New code.
                  </p>
                ) : null}
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
