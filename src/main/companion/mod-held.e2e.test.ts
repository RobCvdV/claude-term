import { describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PendingPrompt, PromptOutcome } from 'claude-term-protocol'
import { StatusServer } from '../status-server'
import type { TurnActivity } from '../../shared/types'
import { buildHooks } from '../hook-config'
import { handleModRequest } from './mod-requests'
import { ParkedPrompts } from './parked-prompts'

/**
 * Prompts the term-bridge mod holds, with nothing faked but the phone: a real
 * `claude` loads the real mod, claude-term's status server holds what it asks,
 * and the test answers as a phone would.
 *
 * Opt-in (`CLAUDE_TERM_E2E=1`) — it needs the claude binary and a model.
 */
const RUN_E2E = process.env.CLAUDE_TERM_E2E === '1'
const MOD_DIR = join(process.cwd(), 'resources/term-bridge')

async function until<T>(what: string, probe: () => T | undefined | false, ms = 90_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = probe()
    if (v) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function session(
  prompt: string,
  expireMs: number,
  env: Record<string, string> = {}
): Promise<{
  parked: ParkedPrompts
  seen: PendingPrompt[]
  outcomes: PromptOutcome[]
  doings: TurnActivity[]
  fixture: string
  done: Promise<string>
  stop: () => void
}> {
  const dir = mkdtempSync(join(tmpdir(), 'ct-mod-'))
  const status = new StatusServer()
  const parked = new ParkedPrompts(expireMs)
  parked.canPark = () => true
  const seen: PendingPrompt[] = []
  parked.onParked = (p) => seen.push(p)
  const outcomes: PromptOutcome[] = []
  parked.onResolved = (_p, outcome) => outcomes.push(outcome)
  status.parkHook = (tabId, evt, res) => parked.tryPark(tabId, evt, res)
  status.onHook = (tabId, evt) => parked.noteHook(tabId, evt)
  const doings: TurnActivity[] = []
  status.onUpdate = (st) => {
    if (st.doing) doings.push({ ...st.doing })
  }
  status.onModEvent = (tabId, event) => {
    if (event.kind === 'keys') parked.noteKeys(tabId, String(event.state))
    else if (event.kind === 'turn.start') status.markTurn(tabId, true)
    else if (event.kind === 'turn.complete') status.markTurn(tabId, false)
    else if (event.kind === 'spinner')
      status.markSpinner(tabId, String(event.word), String(event.mode))
    else if (event.kind === 'tool.start')
      status.markTool(tabId, String(event.tool), (event.detail as string) ?? null)
    else if (event.kind === 'tool.end') status.markTool(tabId, null)
  }
  status.onModRequest = (tabId, action, body) =>
    handleModRequest({ parked, dialogOpen: () => {} }, tabId, action, body)
  await status.start()
  const fixture = join(dir, 'tui-empty-0-mod', 'fixture')
  status.registerTab('t', fixture)
  const url = `http://127.0.0.1:${status.port}/hook?tab=t&token=${status.token}`
  const settings = join(dir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: buildHooks(url),
      permissions: { defaultMode: 'default', ask: ['Bash(mkdir *)'] },
      effortLevel: 'low'
    })
  )
  const tui = spawn(
    'python3',
    [join(process.cwd(), 'scripts/hook-spike/tui.py'), 'empty', '0', '100'],
    {
      env: {
        ...process.env,
        SPIKE_HOOK_URL: url,
        SPIKE_SETTINGS_FILE: settings,
        SPIKE_OUT: dir,
        SPIKE_TAG: '-mod',
        SPIKE_PROMPT: prompt,
        SPIKE_EXTRA_ARGS: JSON.stringify(['--plugin-dir', MOD_DIR]),
        CLAUDE_TERM_PORT: String(status.port),
        CLAUDE_TERM_TAB_ID: 't',
        CLAUDE_TERM_TOKEN: status.token,
        ...env
      }
    }
  )
  let out = ''
  tui.stdout.on('data', (d) => (out += d))
  const done = new Promise<string>((resolve) => tui.on('close', () => resolve(out)))
  return {
    parked,
    seen,
    outcomes,
    doings,
    fixture,
    done,
    stop: () => {
      tui.kill()
      status.stop()
    }
  }
}

describe.runIf(RUN_E2E)('mod-held prompts end to end', () => {
  it('asks an expired permission again, and runs it once a phone allows', async () => {
    const s = await session(
      'Use the Bash tool to run exactly: mkdir spike-proof-empty   — then stop.',
      8_000
    )
    try {
      await until('the permission', () => s.seen.find((p) => p.hook === 'PermissionRequest'))
      const reasked = await until('the re-ask', () => s.seen.find((p) => p.reasked), 60_000)
      expect(reasked).toMatchObject({ hook: 'mod', kind: 'permission', toolName: 'Bash' })
      expect(s.parked.decide(reasked.id, { kind: 'allow' })).toBe(true)
      await until('the tool to run', () => existsSync(join(s.fixture, 'spike-proof-empty')), 60_000)
    } finally {
      s.stop()
    }
  }, 240_000)

  it.each([
    ['allowed', '\r'],
    ['dismissed', 'esc']
  ])(
    'takes the card off the phone once the terminal has %s it',
    async (_how, key) => {
      const s = await session(
        'Use the Bash tool to run exactly: mkdir spike-proof-empty   — then stop.',
        120_000,
        { SPIKE_ANSWER_AT: '8', ...(key === 'esc' ? { SPIKE_ANSWER_KEY: 'esc' } : {}) }
      )
      try {
        await until('the permission', () => s.seen.find((p) => p.hook === 'PermissionRequest'))
        await until('the card to go', () => s.outcomes.includes('terminal'), 30_000)
        expect(s.parked.pending()).toHaveLength(0)
      } finally {
        s.stop()
      }
    },
    240_000
  )

  it('runs an expired permission allowed at the terminal', async () => {
    const s = await session(
      'Use the Bash tool to run exactly: mkdir spike-proof-empty   — then stop.',
      8_000,
      // past the expiry, Enter picks the re-ask's first option: Allow
      { SPIKE_ANSWER_AT: '25', SPIKE_ANSWER_PRESSES: '3' }
    )
    try {
      await until('the re-ask', () => s.seen.find((p) => p.reasked), 60_000)
      await until('the tool to run', () => existsSync(join(s.fixture, 'spike-proof-empty')), 60_000)
    } finally {
      s.stop()
    }
  }, 240_000)

  it('hands on a re-run that fails as an error, not as a broken answer', async () => {
    const s = await session(
      'Use the Bash tool to run exactly: mkdir /nonexistent-spike/x   — then stop.',
      8_000
    )
    try {
      const reasked = await until('the re-ask', () => s.seen.find((p) => p.reasked), 60_000)
      s.parked.decide(reasked.id, { kind: 'allow' })
      await s.done
      const out = readFileSync(join(s.fixture, '..', 'tui.raw'), 'utf8')
      expect(out).not.toMatch(/output shape/)
      expect(out.replace(/\s+/g, '')).toMatch(/Nosuchfileordirectory/)
    } finally {
      s.stop()
    }
  }, 240_000)

  it('offers a question again when its card was dropped, and takes the answer', async () => {
    const s = await session(
      'Use the AskUserQuestion tool to ask me exactly one question, "Pick a color?", with the options Red and Blue. Then reply with only the answer I gave.',
      570_000
    )
    try {
      const first = await until('the question', () => s.seen.find((p) => p.kind === 'question'))
      // as if claude-term had lost it while the session still waits
      s.parked.closeForMod(first.id)
      const again = await until('the question again', () =>
        s.seen.find((p) => p.kind === 'question' && p.id !== first.id)
      )
      expect(s.parked.decide(again.id, { kind: 'respond', text: 'Blue' })).toBe(true)
      await s.done
      expect(readFileSync(join(s.fixture, '..', 'tui.raw'), 'utf8')).toMatch(
        /Pick a color\? → Blue/
      )
    } finally {
      s.stop()
    }
  }, 240_000)

  it('lets a phone answer a question the terminal is showing too', async () => {
    const s = await session(
      'Use the AskUserQuestion tool to ask me exactly one question, "Pick a color?", with the options Red and Blue. Then reply with only the answer I gave.',
      570_000
    )
    try {
      const q = await until('the question', () => s.seen.find((p) => p.kind === 'question'))
      expect(q.hook).toBe('mod')
      expect(s.parked.decide(q.id, { kind: 'respond', text: 'Blue' })).toBe(true)
      await s.done
      // the PermissionRequest hook leaves it to the mod: one card, not two
      expect(s.seen.filter((p) => p.kind === 'question')).toHaveLength(1)
      expect(readFileSync(join(s.fixture, '..', 'tui.raw'), 'utf8')).toMatch(
        /Pick a color\? → Blue/
      )
    } finally {
      s.stop()
    }
  }, 240_000)

  it('reports what a turn is doing: the spinner, the tool and the steps', async () => {
    const s = await session('Use the Read tool to read readme.md, then say what it says.', 570_000)
    try {
      await s.done
      expect(s.doings.some((d) => d.word !== '')).toBe(true)
      expect(s.doings).toContainEqual(expect.objectContaining({ tool: 'Read' }))
      expect(s.doings.some((d) => d.steps >= 1)).toBe(true)
    } finally {
      s.stop()
    }
  }, 240_000)
})
