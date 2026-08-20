import { createServer, type Server } from 'http'
import { networkInterfaces } from 'os'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  parseClientFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type CompanionErrorCode,
  type CompanionSession,
  type ServerFrame
} from '../../shared/companion'
import { bindAddresses } from './bind-address'
import { DeviceRegistry, newNonce, verifySignature } from './devices'
import { Pairing } from './pairing'

/** A socket that has not proved who it is gets this long, then it is dropped. */
export const AUTH_GRACE_MS = 10_000
/** A client sending faster than this is not a phone; drop it. */
export const FRAME_BUDGET = 200
export const FRAME_WINDOW_MS = 10_000

interface Client {
  socket: WebSocket
  nonce: string
  deviceId: string | null
  name: string
  /** the device is on screen, looking at this tab — suppresses its push */
  foreground: boolean
  foregroundTab: string | null
  authTimer: NodeJS.Timeout | null
  frames: number
  windowStart: number
}

export interface CompanionServerDeps {
  devices: DeviceRegistry
  pairing: Pairing
  hostName: string
  /** The session list to hand a device the moment it authenticates. */
  sessions?: () => CompanionSession[]
  /** Overridable for tests; how long a socket may stay anonymous. */
  authGraceMs?: number
  /**
   * Asked before a newly paired key is trusted. The pairing code already proves
   * the person scanning can see this screen; this is the second pair of eyes.
   */
  confirmPairing?: (name: string) => Promise<boolean>
}

/**
 * The companion transport.
 *
 * Binds to loopback and the tailnet address only — never 0.0.0.0 — so nothing on
 * the local network can reach it. Confidentiality and host authentication come
 * from WireGuard; this layer answers "which of my devices is this, and is the
 * request fresh?" with an Ed25519 challenge/response. No bearer token is ever
 * put on the wire.
 */
export class CompanionServer {
  private servers: Server[] = []
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private stopped = false

  port = 0
  addresses: string[] = []

  /** Set by the hub: a device finished authenticating. */
  onReady: (deviceId: string, name: string) => void = () => {}
  /** Set by the hub: an authenticated frame arrived. */
  onFrame: (deviceId: string, frame: ClientFrame) => void = () => {}
  /** Set by the hub: the number of authenticated devices changed. */
  onPresence: (count: number) => void = () => {}

  constructor(private readonly deps: CompanionServerDeps) {}

  async start(preferredPort = 0): Promise<void> {
    this.stopped = false
    this.addresses = bindAddresses(networkInterfaces())
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

    // One listener per allowed address, sharing a single WebSocket server, so
    // "loopback + tailnet and nothing else" is enforced by the bind itself.
    let port = preferredPort
    for (const address of this.addresses) {
      const server = createServer((_req, res) => res.writeHead(404).end())
      server.on('upgrade', (req, socket, head) => {
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
      })
      try {
        port = await listen(server, port, address)
      } catch {
        // The persisted port is taken on this interface (another instance, or a
        // stale binding). Fall back to an ephemeral one and keep going.
        port = await listen(server, 0, address)
      }
      this.servers.push(server)
    }
    this.port = port
  }

  stop(): void {
    this.stopped = true
    for (const client of [...this.clients]) this.drop(client)
    this.wss?.close()
    for (const server of this.servers) server.close()
    this.servers = []
    this.wss = null
  }

  /** Devices currently authenticated — what `canPark` is decided from. */
  authenticatedCount(): number {
    return [...this.clients].filter((c) => c.deviceId).length
  }

  broadcast(frame: ServerFrame): void {
    for (const client of this.clients) {
      if (client.deviceId) this.write(client, frame)
    }
  }

  /** Devices that are backgrounded, or not looking at this tab — i.e. push targets. */
  inattentiveDevices(tabId: string): string[] {
    const seen: string[] = []
    for (const client of this.clients) {
      if (!client.deviceId) continue
      if (client.foreground && client.foregroundTab === tabId) continue
      seen.push(client.deviceId)
    }
    return seen
  }

  private accept(socket: WebSocket): void {
    if (this.stopped) {
      socket.close()
      return
    }
    const client: Client = {
      socket,
      nonce: newNonce(),
      deviceId: null,
      name: '',
      foreground: false,
      foregroundTab: null,
      authTimer: null,
      frames: 0,
      windowStart: Date.now()
    }
    this.clients.add(client)
    client.authTimer = setTimeout(() => {
      if (!client.deviceId) this.drop(client)
    }, this.deps.authGraceMs ?? AUTH_GRACE_MS)

    socket.on('message', (data) => void this.onMessage(client, data.toString()))
    socket.on('close', () => this.forget(client))
    socket.on('error', () => this.drop(client))

    this.write(client, {
      type: 'challenge',
      protocol: PROTOCOL_VERSION,
      nonce: client.nonce,
      hostName: this.deps.hostName,
      // tells a device whether to offer "scan a code" or just reconnect
      paired: this.deps.devices.list().length > 0
    })
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    if (!this.overBudget(client)) return
    const frame = parseClientFrame(raw)
    if (!frame) {
      this.fail(client, 'malformed', 'unrecognised frame')
      return
    }
    if (frame.type === 'ping') {
      this.write(client, { type: 'pong' })
      return
    }
    if (!client.deviceId) {
      if (frame.type === 'pair') await this.handlePair(client, frame)
      else if (frame.type === 'auth') this.handleAuth(client, frame)
      else this.fail(client, 'unauthenticated', 'authenticate first')
      return
    }
    if (frame.type === 'appState') {
      client.foreground = frame.foreground
      client.foregroundTab = frame.tabId ?? null
      return
    }
    // `pair`/`auth` on an established socket is meaningless; ignore rather than
    // letting a device swap identity mid-connection.
    if (frame.type === 'pair' || frame.type === 'auth') return
    this.onFrame(client.deviceId, frame)
  }

  private handleAuth(client: Client, frame: Extract<ClientFrame, { type: 'auth' }>): void {
    if (frame.protocol !== PROTOCOL_VERSION) {
      this.fail(client, 'protocol', `host speaks protocol ${PROTOCOL_VERSION}`)
      return
    }
    const device = this.deps.devices.authenticate(frame.deviceId, client.nonce, frame.signature)
    if (!device) {
      // Deliberately one message for "no such device" and "bad signature": which
      // it was is not a stranger's business.
      this.fail(client, 'bad-signature', 'authentication failed')
      return
    }
    this.deps.devices.touch(device.deviceId, frame.pushToken)
    this.establish(client, device.deviceId, device.name)
  }

  private async handlePair(
    client: Client,
    frame: Extract<ClientFrame, { type: 'pair' }>
  ): Promise<void> {
    if (frame.protocol !== PROTOCOL_VERSION) {
      this.fail(client, 'protocol', `host speaks protocol ${PROTOCOL_VERSION}`)
      return
    }
    // Prove possession of the key being enrolled *before* spending the code, so
    // a malformed attempt cannot burn a valid offer.
    if (!verifySignature(frame.publicKey, client.nonce, frame.deviceId, frame.signature)) {
      this.fail(client, 'bad-signature', 'key does not match the signature')
      return
    }
    if (!this.deps.pairing.redeem(frame.code)) {
      this.fail(client, 'bad-pairing-code', 'that code is not valid')
      return
    }
    // The code is spent and the key is proven, so the only thing left is a human
    // clicking a dialog. Stop the anonymous-socket timer before waiting on that:
    // a person takes longer than a handshake, and dropping them mid-decision is
    // how this looked like "pairing silently fails".
    this.holdOpen(client)
    const confirm = this.deps.confirmPairing ?? (async (): Promise<boolean> => true)
    if (!(await confirm(frame.name))) {
      this.fail(client, 'bad-pairing-code', 'pairing was declined on the host')
      return
    }
    const device = this.deps.devices.add({
      deviceId: frame.deviceId,
      name: frame.name,
      publicKey: frame.publicKey,
      ...(frame.pushToken ? { pushToken: frame.pushToken } : {})
    })
    this.establish(client, device.deviceId, device.name)
  }

  /** Stop counting this socket as anonymous, without authenticating it yet. */
  private holdOpen(client: Client): void {
    if (client.authTimer) clearTimeout(client.authTimer)
    client.authTimer = null
  }

  private establish(client: Client, deviceId: string, name: string): void {
    // One connection per device: a reconnect supersedes whatever came before,
    // which is what a phone waking from sleep looks like.
    for (const other of [...this.clients]) {
      if (other !== client && other.deviceId === deviceId) this.drop(other)
    }
    client.deviceId = deviceId
    client.name = name
    this.holdOpen(client)
    this.write(client, {
      type: 'ready',
      deviceId,
      name,
      sessions: this.deps.sessions?.() ?? []
    })
    this.onReady(deviceId, name)
    this.onPresence(this.authenticatedCount())
  }

  private overBudget(client: Client): boolean {
    const now = Date.now()
    if (now - client.windowStart > FRAME_WINDOW_MS) {
      client.windowStart = now
      client.frames = 0
    }
    if (++client.frames > FRAME_BUDGET) {
      this.drop(client)
      return false
    }
    return true
  }

  private write(client: Client, frame: ServerFrame): void {
    if (client.socket.readyState !== 1) return
    try {
      client.socket.send(JSON.stringify(frame))
    } catch {
      /* the socket went away between the check and the send */
    }
  }

  /** Cut a device off immediately — used the moment it is revoked. */
  dropDevice(deviceId: string): void {
    for (const client of [...this.clients]) {
      if (client.deviceId === deviceId) this.drop(client)
    }
  }

  sendTo(deviceId: string, frame: ServerFrame): void {
    for (const client of this.clients) {
      if (client.deviceId === deviceId) this.write(client, frame)
    }
  }

  private fail(client: Client, code: CompanionErrorCode, message: string): void {
    this.write(client, { type: 'error', code, message })
    this.drop(client)
  }

  private drop(client: Client): void {
    try {
      client.socket.close()
    } catch {
      /* already gone */
    }
    this.forget(client)
  }

  private forget(client: Client): void {
    if (client.authTimer) clearTimeout(client.authTimer)
    const wasAuthed = client.deviceId !== null
    if (!this.clients.delete(client)) return
    if (wasAuthed) this.onPresence(this.authenticatedCount())
  }
}

function listen(server: Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, address, () => {
      server.removeListener('error', onError)
      const addr = server.address()
      resolve(addr && typeof addr === 'object' ? addr.port : port)
    })
  })
}
