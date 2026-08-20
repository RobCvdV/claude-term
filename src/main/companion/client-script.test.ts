import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { DeviceRegistry } from './devices'
import { Pairing } from './pairing'
import { CompanionServer } from './server'

/**
 * scripts/companion-client.mjs stands in for the phone, so it has to speak the
 * real protocol — key encodings included. This runs it against a live server.
 */
const run = promisify(execFile)

let dir: string
let server: CompanionServer
let pairing: Pairing
let devices: DeviceRegistry

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ct-client-'))
  devices = new DeviceRegistry(() => join(dir, 'devices.json'))
  pairing = new Pairing()
  server = new CompanionServer({ devices, pairing, hostName: 'test-host' })
  await server.start(0)
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const client = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  run('node', [join(process.cwd(), 'scripts/companion-client.mjs'), ...args], {
    env: { ...process.env, COMPANION_STORE: join(dir, 'client.json') },
    timeout: 20_000
  })

describe('companion-client.mjs', () => {
  it('pairs with a real server and stores its own key', async () => {
    const { code } = pairing.offer()
    const { stdout } = await client([
      'pair',
      '--host',
      '127.0.0.1',
      '--port',
      String(server.port),
      '--code',
      code
    ])

    expect(stdout).toMatch(/host “test-host”/)
    expect(stdout).toMatch(/paired as/)
    expect(devices.list()).toHaveLength(1)

    const store = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8'))
    expect(store.privateKey).toMatch(/BEGIN PRIVATE KEY/)
    // the host stores only the public half
    expect(JSON.stringify(devices.list())).not.toMatch(/PRIVATE/)
  })

  it('reconnects afterwards with a signature over the new nonce', async () => {
    const { code } = pairing.offer()
    const port = String(server.port)
    await client(['pair', '--host', '127.0.0.1', '--port', port, '--code', code])

    // `watch` stays open, so drive it with a command and close its stdin
    const proc = run('node', [join(process.cwd(), 'scripts/companion-client.mjs'), 'watch'], {
      env: { ...process.env, COMPANION_STORE: join(dir, 'client.json') },
      timeout: 20_000
    })
    proc.child.stdin?.end('s\n')
    // give it a moment to authenticate, then take the transport away
    await new Promise((r) => setTimeout(r, 700))
    server.stop()
    const { stdout } = await proc
    expect(stdout).toMatch(/connected as/)
  })

  it('is refused with a bad code, and enrols nothing', async () => {
    pairing.offer()
    await expect(
      client(['pair', '--host', '127.0.0.1', '--port', String(server.port), '--code', 'WRONGWRO'])
    ).rejects.toThrow()
    expect(devices.list()).toHaveLength(0)
  })
})
