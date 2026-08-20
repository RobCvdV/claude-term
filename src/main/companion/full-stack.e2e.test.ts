import { describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { execFile } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { conversationTurns } from '../conversation-search'
import { StatusServer } from '../status-server'
import { buildHooks } from '../hook-config'
import { reachableAddress } from './bind-address'
import { DeviceRegistry } from './devices'
import { addAllowRule } from './allow-rule'
import { ConversationFeed } from './conversation-feed'
import { Notifier } from './notifier'
import { PromptQueue } from './prompt-queue'
import { PushSender } from './push-sender'
import { CompanionHub } from './hub'
import { Pairing } from './pairing'
import { ParkedPrompts } from './parked-prompts'
import { CompanionServer } from './server'

const SCREEN_ROWS = ['> ready', '  waiting for input']

/**
 * The whole chain, with nothing faked: a real `claude` CLI asks for permission,
 * claude-term's status server holds it open, the prompt travels over the real
 * companion transport to a real client process, that client answers it, and the
 * tool runs.
 *
 * Opt-in (`CLAUDE_TERM_E2E=1`) — it needs the claude binary and a model
 * round-trip. Prefers the tailnet address when there is one, so this also
 * exercises the path a phone would actually take.
 */
const RUN_E2E = process.env.CLAUDE_TERM_E2E === '1'
const run = promisify(execFile)

describe.runIf(RUN_E2E)('companion end to end', () => {
  it('carries a real prompt to a real client and back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-full-'))
    const status = new StatusServer()
    const parked = new ParkedPrompts()
    const devices = new DeviceRegistry(() => join(dir, 'devices.json'))
    const pairing = new Pairing()
    // The real transcript reader. `sessionId` normally arrives on the statusline,
    // which needs the packaged forwarder script, so take it from the hook payload
    // the parked prompt carries instead.
    let liveSession: string | null = null
    const addRule = (cwd: string, rule: string): boolean => addAllowRule(cwd, rule)
    const feed = new ConversationFeed({
      turnsFor: (sessionId) => conversationTurns(sessionId),
      sessionOf: () => liveSession
    })
    const companion = new CompanionServer({
      devices,
      pairing,
      hostName: 'e2e-host',
      sessions: () => hub.sessionList()
    })
    const hub = new CompanionHub({
      server: companion,
      parked,
      feed,
      snapshots: () => status.allSnapshots(),
      snapshot: (tabId) => status.snapshot(tabId),
      queue: new PromptQueue({ deliver: () => {}, ready: () => true }),
      notifier: new Notifier({ hostFocused: () => false }),
      push: new PushSender({
        fetch: (async () => new Response('{}')) as never,
        onTokenRejected: () => {}
      }),
      pushTokenFor: () => null,
      addRule,
      screen: async () => SCREEN_ROWS
    })
    hub.start()
    const hubOnParked = parked.onParked
    parked.onParked = (prompt) => {
      liveSession ??= prompt.sessionId
      hubOnParked(prompt)
    }
    status.parkHook = (tabId, evt, res) => parked.tryPark(tabId, evt, res)
    await status.start()
    await companion.start(0)
    // the harness runs claude here, so the tab's cwd must match for a written
    // permission rule to land where that session will read it
    const fixture = join(dir, 'tui-empty-0-full', 'fixture')
    status.registerTab('spike', fixture)

    const host = reachableAddress() ?? '127.0.0.1'
    const store = join(dir, 'client.json')
    const clientEnv = { ...process.env, COMPANION_STORE: store }
    const script = join(process.cwd(), 'scripts/companion-client.mjs')

    // 1. pair, over the tailnet if this machine has one
    const { code } = pairing.offer()
    const pairOut = await run(
      'node',
      [script, 'pair', '--host', host, '--port', String(companion.port), '--code', code],
      { env: clientEnv, timeout: 20_000 }
    )
    expect(pairOut.stdout).toMatch(/paired as/)
    expect(devices.list()).toHaveLength(1)

    // 2. keep a client connected; it is what makes prompts parkable at all
    const client = spawn('node', [script, 'watch'], { env: clientEnv })
    let clientOut = ''
    client.stdout.on('data', (d) => (clientOut += d))
    client.stderr.on('data', (d) => (clientOut += d))
    const waitFor = async (re: RegExp, ms = 90_000): Promise<RegExpMatchArray> => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const m = clientOut.match(re)
        if (m) return m
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`never saw ${re}; output was:\n${clientOut}`)
    }
    await waitFor(/connected as/, 15_000)
    expect(companion.authenticatedCount()).toBe(1)

    // 3. a real session asks for permission
    const settings = join(dir, 'settings.json')
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: buildHooks(`http://127.0.0.1:${status.port}/hook?tab=spike&token=${status.token}`),
        permissions: { defaultMode: 'default', ask: ['Bash(mkdir *)'] },
        effortLevel: 'low'
      })
    )
    const tui = spawn(
      'python3',
      [join(process.cwd(), 'scripts/hook-spike/tui.py'), 'empty', '0', '120'],
      {
        env: {
          ...process.env,
          SPIKE_HOOK_URL: `http://127.0.0.1:${status.port}/hook?tab=spike&token=${status.token}`,
          SPIKE_SETTINGS_FILE: settings,
          SPIKE_OUT: dir,
          SPIKE_TAG: '-full'
        }
      }
    )
    let tuiOut = ''
    tui.stdout.on('data', (d) => (tuiOut += d))

    // 4. the prompt reaches the client, with the command it is asking about
    const seen = await waitFor(/▸ PERMISSION\s+Bash\s+\[([0-9a-f]{8})\]/)
    expect(clientOut).toMatch(/mkdir spike-proof/)

    // 5. answer it from the client — and remember the rule, so the same command
    //    is not asked about again
    expect(clientOut).toMatch(/would allow: Bash\(mkdir \*\)/)
    client.stdin.write(`A ${seen[1]}\n`)
    await waitFor(/✓ rule added: Bash\(mkdir \*\)/)
    await waitFor(new RegExp(`✓ ${seen[1]} → answered`))

    // 6. and the tool actually ran
    const finished = await new Promise<string>((resolve) => {
      tui.on('close', () => resolve(tuiOut))
    })
    expect(finished).toContain('tool ran: True')

    // 7. the rule really landed in the file Claude Code reads
    const rules = JSON.parse(
      readFileSync(join(fixture, '.claude', 'settings.local.json'), 'utf8')
    ) as { permissions: { allow: string[] } }
    expect(rules.permissions.allow).toContain('Bash(mkdir *)')

    // 8. the conversation itself reaches the client, read from the transcript
    expect(liveSession).toBeTruthy()
    client.stdin.write('w spike\n')
    await waitFor(/── conversation spike/, 20_000)
    await waitFor(/mkdir spike-proof/, 20_000)
    // the prompt that started it all, as a user turn
    expect(clientOut).toMatch(/› user/)

    client.kill()
    companion.stop()
    status.stop()
  }, 240_000)
})
