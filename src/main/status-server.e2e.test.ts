import { describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ParkedPrompts } from './companion/parked-prompts'
import { buildHooks } from './hook-config'
import { StatusServer } from './status-server'
import type { PendingPrompt } from '../shared/companion'

/**
 * The one test that proves the whole chain: a real `claude` CLI asks for a
 * permission, claude-term's own StatusServer holds it open, and answering it
 * here lets the tool run. Everything else about parking is unit-tested; this is
 * the part that can only be checked against the CLI itself.
 *
 * Opt-in (`CLAUDE_TERM_E2E=1 npm test`) because it needs the claude binary, a
 * network round-trip to the model, and about a minute. Driven through
 * scripts/hook-spike/tui.py, which owns the pty — node-pty here is built for
 * Electron's ABI and will not load under plain node.
 */
const RUN_E2E = process.env.CLAUDE_TERM_E2E === '1'

describe.runIf(RUN_E2E)('real CLI against a parked prompt', () => {
  it('holds a permission prompt open and runs the tool once answered', async () => {
    const status = new StatusServer()
    const parked = new ParkedPrompts()
    parked.canPark = () => true
    status.parkHook = (tabId, evt, res) => parked.tryPark(tabId, evt, res)
    await status.start()
    status.registerTab('spike', tmpdir())

    const seen: PendingPrompt[] = []
    parked.onParked = (prompt) => {
      seen.push(prompt)
      // what a phone tap would do
      parked.decide(prompt.id, { kind: 'allow' })
    }

    const dir = mkdtempSync(join(tmpdir(), 'ct-e2e-'))
    const settings = join(dir, 'settings.json')
    const hookUrl = `http://127.0.0.1:${status.port}/hook?tab=spike&token=${status.token}`
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: buildHooks(hookUrl),
        permissions: { defaultMode: 'default', ask: ['Bash(mkdir *)'] },
        effortLevel: 'low'
      })
    )

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'python3',
        [join(process.cwd(), 'scripts/hook-spike/tui.py'), 'empty', '0', '90'],
        {
          env: {
            ...process.env,
            SPIKE_HOOK_URL: hookUrl,
            SPIKE_SETTINGS_FILE: settings,
            SPIKE_OUT: dir,
            SPIKE_TAG: '-e2e'
          }
        }
      )
      let buf = ''
      child.stdout.on('data', (d) => (buf += d))
      child.stderr.on('data', (d) => (buf += d))
      child.on('error', reject)
      child.on('close', () => resolve(buf))
    })

    parked.releaseAll('shutdown')
    status.stop()

    expect(seen.map((p) => p.toolName)).toContain('Bash')
    expect(seen[0].summary).toContain('mkdir')
    expect(out).toContain('tool ran: True')
  }, 180_000)
})
