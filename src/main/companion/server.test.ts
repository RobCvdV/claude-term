import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID, sign } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from 'claude-term-protocol'
import { authPayload, DeviceRegistry } from './devices'
import { Pairing } from './pairing'
import { CompanionServer } from './server'

let dir: string
let devices: DeviceRegistry
let pairing: Pairing
let server: CompanionServer
let confirmPairing: (name: string) => Promise<boolean>
let authGraceMs: number | undefined

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ct-companion-'))
  devices = new DeviceRegistry(() => join(dir, 'devices.json'))
  pairing = new Pairing()
  confirmPairing = async () => true
  authGraceMs = undefined
  server = new CompanionServer({
    devices,
    pairing,
    hostName: 'test-host',
    confirmPairing: (name) => confirmPairing(name),
    get authGraceMs() {
      return authGraceMs
    }
  })
  await server.start(0)
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A device: its keypair, and a socket that collects frames. */
function makeDevice(): {
  deviceId: string
  publicKey: string
  signFor: (nonce: string) => string
} {
  const deviceId = randomUUID()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    deviceId,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signFor: (nonce) => sign(null, authPayload(nonce, deviceId), privateKey).toString('base64')
  }
}

interface Conn {
  frames: ServerFrame[]
  send: (frame: ClientFrame) => void
  next: <T extends ServerFrame['type']>(type: T) => Promise<Extract<ServerFrame, { type: T }>>
  closed: () => boolean
  close: () => void
}

function connect(): Promise<Conn> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  const frames: ServerFrame[] = []
  let isClosed = false
  socket.on('message', (d) => frames.push(JSON.parse(d.toString())))
  socket.on('close', () => (isClosed = true))
  socket.on('error', () => (isClosed = true))

  const next = async <T extends ServerFrame['type']>(
    type: T
  ): Promise<Extract<ServerFrame, { type: T }>> => {
    for (let i = 0; i < 200; i++) {
      const found = frames.find((f) => f.type === type)
      if (found) return found as Extract<ServerFrame, { type: T }>
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`no ${type} frame; got ${frames.map((f) => f.type).join(',') || '(none)'}`)
  }

  return new Promise((resolve, reject) => {
    socket.on('open', () =>
      resolve({
        frames,
        send: (frame) => socket.send(JSON.stringify(frame)),
        next,
        closed: () => isClosed,
        close: () => socket.close()
      })
    )
    socket.on('error', reject)
  })
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Pair a device and leave it authenticated. */
async function paired(): Promise<{ conn: Conn; device: ReturnType<typeof makeDevice> }> {
  const device = makeDevice()
  const conn = await connect()
  const challenge = await conn.next('challenge')
  const { code } = pairing.offer()
  conn.send({
    type: 'pair',
    protocol: PROTOCOL_VERSION,
    deviceId: device.deviceId,
    name: 'Test iPhone',
    publicKey: device.publicKey,
    code,
    signature: device.signFor(challenge.nonce)
  })
  await conn.next('ready')
  return { conn, device }
}

describe('CompanionServer binding', () => {
  it('listens on loopback and never on a wildcard', () => {
    expect(server.addresses).toContain('127.0.0.1')
    expect(server.addresses).not.toContain('0.0.0.0')
    for (const a of server.addresses) {
      expect(a === '127.0.0.1' || a.startsWith('100.')).toBe(true)
    }
  })
})

describe('CompanionServer handshake', () => {
  it('challenges immediately, with a fresh nonce each time', async () => {
    const a = await connect()
    const b = await connect()
    const first = await a.next('challenge')
    const second = await b.next('challenge')
    expect(first.protocol).toBe(PROTOCOL_VERSION)
    expect(first.hostName).toBe('test-host')
    expect(first.paired).toBe(false)
    expect(first.nonce).not.toBe(second.nonce)
  })

  it('reports whether any device is already paired', async () => {
    devices.add({ deviceId: 'd1', name: 'x', publicKey: makeDevice().publicKey })
    expect((await (await connect()).next('challenge')).paired).toBe(true)
  })

  it('refuses everything before authentication', async () => {
    const conn = await connect()
    await conn.next('challenge')
    conn.send({ type: 'sessions' })
    expect((await conn.next('error')).code).toBe('unauthenticated')
    await settle()
    expect(conn.closed()).toBe(true)
  })

  it('answers a ping without authentication, so a device can probe the host', async () => {
    const conn = await connect()
    await conn.next('challenge')
    conn.send({ type: 'ping' })
    await conn.next('pong')
    expect(conn.closed()).toBe(false)
  })

  it('drops a silent socket that never authenticates', async () => {
    // AUTH_GRACE_MS is 10s; assert the timer exists rather than waiting it out
    const conn = await connect()
    await conn.next('challenge')
    expect(server.authenticatedCount()).toBe(0)
  })

  it('rejects a protocol it does not speak', async () => {
    const device = makeDevice()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION + 99,
      deviceId: device.deviceId,
      signature: device.signFor(challenge.nonce)
    })
    expect((await conn.next('error')).code).toBe('protocol')
  })

  it('ignores a frame it cannot parse', async () => {
    const conn = await connect()
    await conn.next('challenge')
    conn.send({ type: 'nonsense' } as unknown as ClientFrame)
    expect((await conn.next('error')).code).toBe('malformed')
  })
})

describe('CompanionServer pairing', () => {
  it('enrols a device holding a valid code and proving its key', async () => {
    const { device } = await paired()
    expect(devices.get(device.deviceId)?.name).toBe('Test iPhone')
    expect(server.authenticatedCount()).toBe(1)
  })

  it('refuses a wrong code without enrolling anything', async () => {
    const device = makeDevice()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    pairing.offer()
    conn.send({
      type: 'pair',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      name: 'Attacker',
      publicKey: device.publicKey,
      code: 'WRONGWRO',
      signature: device.signFor(challenge.nonce)
    })
    expect((await conn.next('error')).code).toBe('bad-pairing-code')
    expect(devices.list()).toHaveLength(0)
  })

  it('refuses a key the sender cannot prove it holds, and spends no code', async () => {
    const device = makeDevice()
    const impostor = makeDevice()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    const { code } = pairing.offer()
    conn.send({
      type: 'pair',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      name: 'Attacker',
      // claims someone else's key but signs with its own
      publicKey: device.publicKey,
      code,
      signature: impostor.signFor(challenge.nonce)
    })
    expect((await conn.next('error')).code).toBe('bad-signature')
    expect(devices.list()).toHaveLength(0)
    // the offer survived a malformed attempt
    expect(pairing.current()).not.toBeNull()
  })

  it('honours a refusal on the host', async () => {
    confirmPairing = async () => false
    const device = makeDevice()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    const { code } = pairing.offer()
    conn.send({
      type: 'pair',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      name: 'Someone else phone',
      publicKey: device.publicKey,
      code,
      signature: device.signFor(challenge.nonce)
    })
    await conn.next('error')
    expect(devices.list()).toHaveLength(0)
  })

  it('waits for a slow human on the confirmation dialog', async () => {
    // The anonymous-socket timer must not count the time someone spends deciding.
    authGraceMs = 40
    confirmPairing = async () => {
      await new Promise((r) => setTimeout(r, 200))
      return true
    }
    const { device } = await paired()
    expect(devices.get(device.deviceId)).not.toBeNull()
  })

  it('asks about the device by name', async () => {
    const seen = vi.fn(async () => true)
    confirmPairing = seen
    await paired()
    expect(seen).toHaveBeenCalledWith('Test iPhone')
  })

  it('will not enrol a second device with the same code', async () => {
    const { conn } = await paired()
    expect(conn.closed()).toBe(false)
    const second = makeDevice()
    const other = await connect()
    const challenge = await other.next('challenge')
    other.send({
      type: 'pair',
      protocol: PROTOCOL_VERSION,
      deviceId: second.deviceId,
      name: 'Second',
      publicKey: second.publicKey,
      // the code from the first pairing was spent
      code: 'ANYTHING',
      signature: second.signFor(challenge.nonce)
    })
    expect((await other.next('error')).code).toBe('bad-pairing-code')
    expect(devices.list()).toHaveLength(1)
  })
})

describe('CompanionServer authentication', () => {
  it('lets a known device back in with a signature over the new nonce', async () => {
    const { device } = await paired()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      signature: device.signFor(challenge.nonce)
    })
    expect((await conn.next('ready')).deviceId).toBe(device.deviceId)
  })

  it('rejects a replayed signature from an earlier session', async () => {
    const { device } = await paired()
    const first = await connect()
    const stale = await first.next('challenge')
    const captured = device.signFor(stale.nonce)

    const second = await connect()
    await second.next('challenge')
    second.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      signature: captured
    })
    expect((await second.next('error')).code).toBe('bad-signature')
  })

  it('rejects an unknown device without saying it is unknown', async () => {
    const stranger = makeDevice()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: stranger.deviceId,
      signature: stranger.signFor(challenge.nonce)
    })
    const error = await conn.next('error')
    expect(error.code).toBe('bad-signature')
    expect(error.message).not.toMatch(/unknown/i)
  })

  it('locks out a revoked device', async () => {
    const { device } = await paired()
    devices.revoke(device.deviceId)
    const conn = await connect()
    const challenge = await conn.next('challenge')
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      signature: device.signFor(challenge.nonce)
    })
    expect((await conn.next('error')).code).toBe('bad-signature')
  })

  it('records the push token it was given', async () => {
    const { device } = await paired()
    const conn = await connect()
    const challenge = await conn.next('challenge')
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      signature: device.signFor(challenge.nonce),
      pushToken: 'ExponentPushToken[xyz]'
    })
    await conn.next('ready')
    expect(devices.get(device.deviceId)?.pushToken).toBe('ExponentPushToken[xyz]')
  })

  it('a reconnect supersedes the previous socket for that device', async () => {
    const { conn: first, device } = await paired()
    const second = await connect()
    const challenge = await second.next('challenge')
    second.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      signature: device.signFor(challenge.nonce)
    })
    await second.next('ready')
    await settle()
    expect(first.closed()).toBe(true)
    expect(server.authenticatedCount()).toBe(1)
  })

  it('will not let an established socket change identity', async () => {
    const { conn, device } = await paired()
    const other = makeDevice()
    conn.send({
      type: 'auth',
      protocol: PROTOCOL_VERSION,
      deviceId: other.deviceId,
      signature: other.signFor('whatever')
    })
    await settle()
    expect(conn.closed()).toBe(false)
    expect(devices.list().map((d) => d.deviceId)).toEqual([device.deviceId])
  })
})

describe('CompanionServer presence', () => {
  it('tracks how many devices are listening', async () => {
    const counts: number[] = []
    server.onPresence = (n) => counts.push(n)
    const { conn } = await paired()
    expect(server.authenticatedCount()).toBe(1)
    conn.close()
    await settle()
    expect(server.authenticatedCount()).toBe(0)
    expect(counts).toEqual([1, 0])
  })

  it('reports a device as attentive only while it watches that very tab', async () => {
    const { conn, device } = await paired()
    expect([...server.attentiveDevices('t1')]).toEqual([])

    conn.send({ type: 'appState', foreground: true, tabId: 't1' })
    await settle()
    expect([...server.attentiveDevices('t1')]).toEqual([device.deviceId])
    // still worth a push about a different tab
    expect([...server.attentiveDevices('t2')]).toEqual([])

    conn.send({ type: 'appState', foreground: false, tabId: 't1' })
    await settle()
    expect([...server.attentiveDevices('t1')]).toEqual([])
  })

  // Revoking used to just close the socket. On the phone that looked like the
  // session freezing: it kept showing the session, and every tap went nowhere
  // because the client drops anything sent on a connection that is not live.
  it('tells a revoked device why before cutting it off', async () => {
    const { conn, device } = await paired()
    expect(devices.revoke(device.deviceId)).toBe(true)
    server.dropDevice(device.deviceId)

    const error = await conn.next('error')
    expect(error.code).toBe('unauthenticated')
    expect(error.message).toMatch(/revoked/)
    await settle()
    expect(server.authenticatedCount()).toBe(0)
  })

  it('forwards authenticated frames to the hub', async () => {
    const seen: ClientFrame[] = []
    server.onFrame = (_id, frame) => seen.push(frame)
    const { conn } = await paired()
    conn.send({ type: 'submit', tabId: 't1', text: 'hello' })
    await settle()
    expect(seen).toEqual([{ type: 'submit', tabId: 't1', text: 'hello' }])
  })

  it('drops a client that floods it', async () => {
    const { conn } = await paired()
    for (let i = 0; i < 400; i++) conn.send({ type: 'ping' })
    await settle(200)
    expect(conn.closed()).toBe(true)
  })

  it('stops cleanly, dropping every client', async () => {
    const { conn } = await paired()
    server.stop()
    await settle()
    expect(conn.closed()).toBe(true)
    expect(server.authenticatedCount()).toBe(0)
  })
})
