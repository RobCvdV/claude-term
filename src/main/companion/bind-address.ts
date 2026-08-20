import { networkInterfaces } from 'os'

/**
 * Tailscale hands every node an address in the CGNAT range 100.64.0.0/10. That
 * range is what makes "only reachable over the tailnet" enforceable at bind
 * time rather than by a firewall rule someone has to remember.
 */
export function isTailscaleV4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map((p) => Number(p))
  if (a !== 100 || Number.isNaN(b)) return false
  return b >= 64 && b <= 127
}

export interface NetIface {
  address: string
  family: string | number
  internal: boolean
}

/**
 * Where the companion server may listen. Loopback always, plus the tailnet
 * address when there is one — never a LAN address and never 0.0.0.0, so nothing
 * on the local Wi-Fi can reach it even briefly.
 */
export function bindAddresses(ifaces: Record<string, NetIface[] | undefined>): string[] {
  const found = new Set<string>(['127.0.0.1'])
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      const v4 = iface.family === 'IPv4' || iface.family === 4
      if (!v4 || iface.internal) continue
      if (isTailscaleV4(iface.address)) found.add(iface.address)
    }
  }
  return [...found]
}

/** The address to advertise in a pairing QR — the tailnet one if we have it. */
export function reachableAddress(
  ifaces = networkInterfaces() as Record<string, NetIface[]>
): string | null {
  return bindAddresses(ifaces).find((a) => a !== '127.0.0.1') ?? null
}
