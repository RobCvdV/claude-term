import type { Engine, Register } from 'claude-code'

// Transcript rows redraw constantly and say nothing about who owns the keys.
const RENDERS = new Set(['AbovePrompt', 'PromptHint', 'SessionMode', 'AskUserQuestion'])
const PROBE_MS = 400

let endpoint: string | null = null
let sessionId = ''
let loopGen = 0
const lastRender: Record<string, number> = {}

async function report($: Engine, kind: string, data: object = {}): Promise<void> {
  if (!endpoint) return
  const body = JSON.stringify({ kind, session_id: sessionId, ...data })
  try {
    await within($, 500, $.http.fetch(endpoint, { method: 'POST', body }))
  } catch {
    // claude-term gone or restarting: drop the event
  }
}

async function within<T>($: Engine, ms: number, p: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([p, $.clock.sleep(ms).then(() => 'timeout' as const)])
}

// An empty append is refused with `dialog` while a dialog holds the keys and
// `no_composer` while no prompt box is drawn: the one generic signal for both.
async function probeLoop($: Engine, gen: number): Promise<void> {
  let prev = ''
  while (gen === loopGen) {
    await $.clock.sleep(PROBE_MS)
    let state: string
    let text = ''
    try {
      const box = await within($, 1000, $.prompt.read())
      if (box === 'timeout') state = 'timeout'
      else if (box.text !== '') {
        state = 'typing'
        text = box.text
      } else {
        const f = await within($, 1000, $.prompt.fill({ text: '', mode: 'append' }))
        state = f === 'timeout' ? 'timeout' : (f.refusal ?? (f.isFilled ? 'prompt' : 'refused'))
      }
    } catch (err) {
      state = `error: ${String(err)}`
    }
    if (state !== prev) {
      prev = state
      // the TUI's own draft: what a history-search pick landed there
      await report($, 'keys', text ? { state, text } : { state })
    }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const [port, tab, token] = await Promise.all([
      $.env.get('CLAUDE_TERM_PORT'),
      $.env.get('CLAUDE_TERM_TAB_ID'),
      $.env.get('CLAUDE_TERM_TOKEN')
    ])
    if (port && tab && token) endpoint = `http://127.0.0.1:${port}/mod?tab=${tab}&token=${token}`
    sessionId = String(await $.session.id())
    await report($, 'session.start')
    void probeLoop($, ++loopGen)
    return r
  })

  on('session.end', async ($, e, next) => {
    loopGen++
    await report($, 'session.end')
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    const started = Date.now()
    await report($, 'command.start', { command: e.command, args: e.args })
    const r = await next(e)
    await report($, 'command.end', { command: e.command, ms: Date.now() - started })
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    await report($, 'prompt.submit')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await report($, 'turn.start')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await report($, 'turn.complete')
    return next(e)
  })

  on('ui.render', async ($, e, next) => {
    const c = e.component
    const now = Date.now()
    if (RENDERS.has(c) && now - (lastRender[c] ?? 0) > 1000)
      await report($, 'render', { component: c })
    lastRender[c] = now
    return next(e)
  })
}
