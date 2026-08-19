// Phase 0 spike: logging HTTP hook endpoint for Claude Code `type: "http"` hooks.
// Logs every request verbatim and answers according to SPIKE_POLICY.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const LOG = process.env.SPIKE_LOG || '/tmp/spike-hooks.jsonl'
const POLICY = process.env.SPIKE_POLICY || 'empty'
const DELAY_MS = Number(process.env.SPIKE_DELAY_MS || 0)
const t0 = Date.now()

writeFileSync(LOG, '')

function log(entry) {
  const line = JSON.stringify({ t: Date.now() - t0, ...entry })
  appendFileSync(LOG, line + '\n')
  console.log(line.slice(0, 400))
}

// Response shapes differ per event (docs: PreToolUse uses permissionDecision,
// PermissionRequest uses decision.behavior).
function decision(event, verdict, reason) {
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: verdict === 'allow' ? 'allow' : 'deny' },
        permissionDecisionReason: reason
      }
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: verdict,
      permissionDecisionReason: reason
    }
  }
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { __unparsed: raw }
    }
    const event = body?.hook_event_name ?? body?.hookEventName ?? '?'
    log({ phase: 'req', url: req.url, event, body })
    let gone = false
    req.on('aborted', () => { gone = true; log({ phase: 'ABORTED', event }) })
    res.on('close', () => { if (!res.writableEnded) { gone = true; log({ phase: 'RES_CLOSED_EARLY', event }) } })

    if (DELAY_MS && POLICY !== 'park-perm') await new Promise((r) => setTimeout(r, DELAY_MS))

    let status = 200
    let payload = null
    if (POLICY === 'empty') {
      status = 200
      payload = ''
    } else if (POLICY === '204') {
      status = 204
      payload = ''
    } else if (POLICY === 'allow') {
      payload = decision(event, 'allow', 'spike: approved from the phone')
    } else if (POLICY === 'allow-pre') {
      payload = event === 'PreToolUse' ? decision(event, 'allow', 'spike: PreToolUse only') : ''
    } else if (POLICY === 'allow-perm') {
      payload = event === 'PermissionRequest' ? decision(event, 'allow', 'spike: PermissionRequest only') : ''
    } else if (POLICY === 'answer') {
      // answer a question/plan by DENYING with the answer text as the reason
      payload = event === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny' },
            permissionDecisionReason: process.env.SPIKE_REASON || 'Spaces' } }
        : ''
    } else if (POLICY === 'answer-pre') {
      // answer via PreToolUse deny + reason (reason IS surfaced to the model)
      payload = event === 'PreToolUse'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: process.env.SPIKE_REASON || 'Spaces' } }
        : ''
    } else if (POLICY === 'deny-perm') {
      payload = event === 'PermissionRequest' ? decision(event, 'deny', 'spike: denied from the phone') : ''
    } else if (POLICY === 'park-perm') {
      // park ONLY the permission decision; everything else answers instantly
      if (event === 'PermissionRequest') {
        await new Promise((r) => setTimeout(r, DELAY_MS || 20000))
        payload = decision(event, 'allow', 'spike: answered after parking')
      } else payload = ''
    } else if (POLICY === 'deny') {
      payload = decision(event, 'deny', 'spike: denied from the phone')
    } else if (POLICY === 'ask') {
      payload = decision(event, 'ask', 'spike: bounce to the terminal')
    }

    const out = payload === '' ? '' : JSON.stringify(payload)
    log({ phase: 'res', event, status, out, socketGone: gone })
    res.writeHead(status, out ? { 'content-type': 'application/json' } : {})
    res.end(out)
  })
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(process.env.SPIKE_PORT_FILE || '/tmp/spike-port', String(port))
  console.log(`[spike] policy=${POLICY} delay=${DELAY_MS}ms port=${port} log=${LOG}`)
})
