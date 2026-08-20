#!/usr/bin/env node
// A stand-in for the phone: pairs with a running claude-term and drives it.
//
//   node scripts/companion-client.mjs pair --host 100.x.y.z --port 41234 --code ABCD2345
//   node scripts/companion-client.mjs watch
//
// In watch mode it prints sessions and prompts as they arrive and reads commands
// on stdin:
//   s                    list sessions
//   a <promptId>         allow
//   d <promptId> [why]   deny (the reason only reaches the model on a question)
//   t <promptId> <text>  answer a question / give plan feedback
//   r <promptId>         release — hand it back to the terminal
//   p <tabId> <text>     send a new prompt
//   f <tabId>            claim to be looking at that tab (suppresses its push)
//   b                    claim to be backgrounded
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

const PROTOCOL_VERSION = 1
const AUTH_CONTEXT = 'claude-term/companion/auth/v1'
const STORE = process.env.COMPANION_STORE || join(homedir(), '.claude-term-companion.json')

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

function loadStore() {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return null
  }
}

function saveStore(store) {
  writeFileSync(STORE, JSON.stringify(store, null, 2))
  chmodSync(STORE, 0o600)
}

const authPayload = (nonce, deviceId) =>
  Buffer.from(`${AUTH_CONTEXT}\n${nonce}\n${deviceId}`, 'utf8')

function signWith(privateKeyPem, nonce, deviceId) {
  return sign(null, authPayload(nonce, deviceId), privateKeyPem).toString('base64')
}

function open(host, port, onChallenge, onFrame) {
  const socket = new WebSocket(`ws://${host}:${port}`)
  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (frame.type === 'challenge') onChallenge(socket, frame)
    else onFrame(socket, frame)
  })
  socket.on('error', (err) => {
    console.error('connection failed:', err.message)
    process.exit(1)
  })
  socket.on('close', () => {
    console.log('— disconnected')
    process.exit(0)
  })
  return socket
}

function describeSession(s) {
  const bits = [s.folder, s.activity]
  if (s.branch) bits.push(s.branch)
  if (s.model) bits.push(s.model)
  if (s.pendingPromptIds.length) bits.push(`${s.pendingPromptIds.length} waiting`)
  return `  ${s.tabId.slice(0, 8)}  ${bits.join('  ·  ')}`
}

function describePrompt(p) {
  const head = `\n▸ ${p.kind.toUpperCase()}  ${p.toolName}  [${p.id.slice(0, 8)}]`
  if (p.kind === 'question') {
    const lines = (p.questions ?? []).map(
      (q) => `    ${q.question}\n${q.options.map((o) => `      · ${o.label}`).join('\n')}`
    )
    return `${head}\n${lines.join('\n')}`
  }
  if (p.kind === 'plan') {
    return `${head}\n${(p.plan ?? '')
      .split('\n')
      .slice(0, 12)
      .map((l) => `    ${l}`)
      .join('\n')}`
  }
  return `${head}\n    ${p.summary}`
}

if (command === 'pair') {
  const host = flag('host', '127.0.0.1')
  const port = Number(flag('port'))
  const code = flag('code')
  if (!port || !code) {
    console.error('need --port and --code (get both from “Pair a phone…” in the app)')
    process.exit(2)
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const deviceId = randomUUID()
  const store = {
    host,
    port,
    deviceId,
    name: `${hostname()} (client script)`,
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }

  open(
    host,
    port,
    (socket, challenge) => {
      console.log(`host “${challenge.hostName}” · protocol ${challenge.protocol}`)
      socket.send(
        JSON.stringify({
          type: 'pair',
          protocol: PROTOCOL_VERSION,
          deviceId,
          name: store.name,
          publicKey: store.publicKey,
          code,
          signature: signWith(store.privateKey, challenge.nonce, deviceId)
        })
      )
    },
    (_socket, frame) => {
      if (frame.type === 'ready') {
        saveStore(store)
        console.log(`paired as “${frame.name}” — credentials in ${STORE}`)
        console.log(`${frame.sessions.length} session(s):`)
        frame.sessions.forEach((s) => console.log(describeSession(s)))
        process.exit(0)
      }
      if (frame.type === 'error') {
        console.error(`pairing refused (${frame.code}): ${frame.message}`)
        process.exit(1)
      }
    }
  )
} else if (command === 'watch') {
  const store = loadStore()
  if (!store) {
    console.error(`no credentials in ${STORE} — run "pair" first`)
    process.exit(2)
  }
  const host = flag('host', store.host)
  const port = Number(flag('port', store.port))

  const socket = open(
    host,
    port,
    (sock, challenge) => {
      sock.send(
        JSON.stringify({
          type: 'auth',
          protocol: PROTOCOL_VERSION,
          deviceId: store.deviceId,
          signature: signWith(store.privateKey, challenge.nonce, store.deviceId)
        })
      )
    },
    (_sock, frame) => {
      switch (frame.type) {
        case 'ready':
          flush()
          console.log(`connected as “${frame.name}” · ${frame.sessions.length} session(s)`)
          frame.sessions.forEach((s) => console.log(describeSession(s)))
          console.log(
            '\ncommands: s | a <id> | d <id> [why] | t <id> <text> | r <id> | p <tab> <text>'
          )
          break
        case 'sessions':
          frame.sessions.forEach((s) => console.log(describeSession(s)))
          break
        case 'session':
          console.log(`~ ${describeSession(frame.session).trim()}`)
          break
        case 'prompt':
          seenPrompts.set(frame.prompt.id, frame.prompt)
          console.log(describePrompt(frame.prompt))
          break
        case 'promptResolved':
          seenPrompts.delete(frame.promptId)
          console.log(`✓ ${frame.promptId.slice(0, 8)} → ${frame.outcome}`)
          break
        case 'error':
          console.log(`! ${frame.code}: ${frame.message}`)
          break
        default:
          break
      }
    }
  )

  // Prompt ids are UUIDs but only their first 8 chars are printed, so resolve
  // whatever prefix was typed against the prompts actually seen.
  const seenPrompts = new Map()
  const resolveId = (prefix) => {
    if (!prefix) return prefix
    if (seenPrompts.has(prefix)) return prefix
    const hits = [...seenPrompts.keys()].filter((id) => id.startsWith(prefix))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) console.log(`? "${prefix}" matches ${hits.length} prompts`)
    return prefix
  }

  // Commands can be typed (or piped) before the handshake finishes, so hold them
  // until the socket is authenticated rather than throwing them at a dead socket.
  let ready = false
  const queued = []
  const send = (frame) => {
    if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
    else queued.push(frame)
  }
  const flush = () => {
    ready = true
    while (queued.length && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(queued.shift()))
    }
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [verb, rawId, ...rest] = line.trim().split(/\s+/)
    const text = rest.join(' ')
    const id = resolveId(rawId)
    if (verb === 's') send({ type: 'sessions' })
    else if (verb === 'a') send({ type: 'decide', promptId: id, decision: { kind: 'allow' } })
    else if (verb === 'd')
      send({ type: 'decide', promptId: id, decision: { kind: 'deny', reason: text || undefined } })
    else if (verb === 't')
      send({ type: 'decide', promptId: id, decision: { kind: 'respond', text } })
    else if (verb === 'r') send({ type: 'decide', promptId: id, decision: { kind: 'release' } })
    else if (verb === 'p') send({ type: 'submit', tabId: id, text })
    else if (verb === 'f') send({ type: 'appState', foreground: true, tabId: id })
    else if (verb === 'b') send({ type: 'appState', foreground: false })
    else if (verb) console.log(`? unknown command "${verb}"`)
  })
} else {
  console.error('usage: companion-client.mjs pair --port N --code XXXX | watch')
  process.exit(2)
}
