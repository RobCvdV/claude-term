import type { Engine, Register } from 'claude-code'

// Transcript rows redraw constantly and say nothing about who owns the keys.
const RENDERS = new Set(['AbovePrompt', 'PromptHint', 'SessionMode', 'AskUserQuestion'])
const PROBE_MS = 400

let endpoint: string | null = null
let requests: { base: string; query: string } | null = null
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

/** Kept in step with EXPIRED_REASON in src/main/companion/parked-prompts.ts. */
const EXPIRED_REASON = 'claude-term: nobody answered this permission prompt in time'

interface Question {
  question: string
  options?: { label: string }[]
}
type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }
  | { kind: 'respond'; text: string }
  | { kind: 'release' }

/** A permission being asked again, keyed by the question that asks it. */
const reasks = new Map<
  string,
  { toolName: string; input: Record<string, unknown>; reason?: string }
>()

/** A request claude-term answers (`/mod/<action>`); `{}` when it can't be reached. */
async function call($: Engine, action: string, data: object): Promise<Record<string, unknown>> {
  if (!requests) return {}
  try {
    const r = await $.http.fetch(`${requests.base}/mod/${action}?${requests.query}`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, ...data })
    })
    return JSON.parse(r.text) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Long-poll for a phone's answer; null once claude-term stops holding it for one. */
/**
 * Long-poll for a phone's answer until one comes, the user sends it back to
 * the terminal, or `stop` aborts. claude-term being out of reach for a while
 * (restarting, the Mac asleep) is waited out, and a card it dropped meanwhile
 * is parked again, so a phone never shows a card nobody is listening to.
 */
async function phoneDecision(
  $: Engine,
  first: string,
  stop: () => boolean,
  repark: () => Promise<string | null>,
  onId: (id: string) => void
): Promise<Decision | null> {
  let id = first
  let failures = 0
  while (!stop()) {
    const r = await call($, 'wait', { id })
    if (r.decision) return r.decision as Decision
    if (r.pending) {
      failures = 0
      continue
    }
    if (r.gone) {
      if (r.released || stop()) return null
      const again = await repark()
      if (!again) return null
      id = again
      onId(id)
      continue
    }
    failures++
    // a $.clock wait would count against this hook's time; a child process doesn't
    await $.process.run(['sleep', String(Math.min(30, 2 ** Math.min(failures, 5)))]).catch(() => {})
  }
  return null
}

function answersFor(questions: Question[], text: string): Record<string, string> {
  const q = questions.find((x) => x.options?.some((o) => o.label === text)) ?? questions[0]
  return q ? { [q.question]: text } : {}
}

function isExpired(r: unknown): boolean {
  const { isError, text } = (r ?? {}) as { isError?: boolean; text?: unknown }
  return isError === true && typeof text === 'string' && text.includes(EXPIRED_REASON)
}

/** What a call works on — the command, the file, the URL — when it says. */
function callDetail(input: Record<string, unknown>): string | null {
  const what = ['command', 'file_path', 'path', 'url', 'pattern', 'description']
    .map((k) => input[k])
    .find((v): v is string => typeof v === 'string')
  return what ? what.slice(0, 200) : null
}

function describeCall(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}: ${callDetail(input) ?? JSON.stringify(input).slice(0, 200)}`
}

/** The last spinner state reported, so a redraw of the same one sends nothing. */
let spinner = { word: '', mode: '' }

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
    if (port && tab && token) {
      endpoint = `http://127.0.0.1:${port}/mod?tab=${tab}&token=${token}`
      requests = { base: `http://127.0.0.1:${port}`, query: `tab=${tab}&token=${token}` }
    }
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
    spinner = { word: '', mode: '' }
    await report($, 'turn.start')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await report($, 'turn.complete')
    return next(e)
  })

  on('ui.render', async ($, e, next) => {
    const c = e.component
    if (c === 'Spinner') {
      const p = e.props as { word: string; message: string | null; mode: string }
      const word = p.message ?? p.word
      if (word !== spinner.word || p.mode !== spinner.mode) {
        spinner = { word, mode: p.mode }
        // never hold a frame up for it
        void report($, 'spinner', spinner)
      }
    }
    const now = Date.now()
    if (RENDERS.has(c) && now - (lastRender[c] ?? 0) > 1000)
      await report($, 'render', { component: c })
    lastRender[c] = now
    return next(e)
  })

  // A question is answered at the terminal or on a phone, whichever is first;
  // returning with next() pending closes the terminal's dialog.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = (e as unknown as { questions?: Question[] }).questions ?? []
    const reask = reasks.get(questions[0]?.question ?? '')
    const park = async (): Promise<string | null> => {
      const r = reask
        ? await call($, 'park', { toolName: reask.toolName, input: reask.input, reasked: true })
        : await call($, 'park', { toolName: 'AskUserQuestion', input: { questions } })
      return typeof r.id === 'string' ? r.id : null
    }
    let id = await park()
    if (!id) return next(e)

    let settled = false
    const stop = (): boolean => settled || next.signal.aborted
    const native = next(e).then((r) => ({ from: 'terminal' as const, r }))
    native.catch(() => {})
    const phone = phoneDecision($, id, stop, park, (newId) => (id = newId)).then((d) => ({
      from: 'phone' as const,
      d
    }))
    let first: Awaited<typeof native> | Awaited<typeof phone> = await Promise.race([native, phone])
    // handed back to the terminal: wait for it there
    if (first.from === 'phone' && (!first.d || first.d.kind === 'release')) first = await native
    settled = true
    if (first.from === 'terminal') {
      await call($, 'close', { id })
      return first.r
    }
    const d = first.d as Decision
    let answers: Record<string, string>
    if (reask) {
      if (d.kind === 'deny' && d.reason) reask.reason = d.reason
      answers = { [questions[0].question]: d.kind === 'allow' ? 'Allow' : 'Deny' }
    } else {
      answers = answersFor(questions, d.kind === 'respond' ? d.text : '')
    }
    return { result: { questions, answers } } as never
  })

  // A permission nobody answered before its hook ran out comes back denied with
  // EXPIRED_REASON. Ask again as a question, which has no time limit, and on
  // Allow re-run the very same call: claude-term lets that one through.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') return next(e)
    const input = { ...(e as unknown as Record<string, unknown>) }
    for (const reserved of ['tool', 'tool_use_id', 'agentId']) delete input[reserved]
    const toolName = e.tool
    await report($, 'tool.start', { tool: toolName, detail: callDetail(input) })
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      await report($, 'tool.end')
    }
    if (!isExpired(r)) return r
    const question = `Allow ${describeCall(toolName, input)}?`
    const reask: { toolName: string; input: Record<string, unknown>; reason?: string } = {
      toolName,
      input
    }
    reasks.set(question, reask)
    let answer = 'Deny'
    try {
      answer = await $.ui.ask(question, { options: ['Allow', 'Deny'], header: 'Permission' })
    } catch {
      // dismissed
    } finally {
      reasks.delete(question)
    }
    if (answer !== 'Allow') return { deny: reask.reason ?? 'The user denied this.' }
    await call($, 'approve', { toolName, input })
    const again = await $.tool.call({ tool: toolName, ...input } as never)
    // Claude Code checks an answer a hook gives against the tool's output shape,
    // and a failed run's error text is not that shape: hand it on as a refusal,
    // which the model reads the same way.
    const failed = again as { isError?: boolean; text?: unknown }
    if (failed.isError)
      return { deny: typeof failed.text === 'string' ? failed.text : 'It failed.' }
    return again
  })
}
