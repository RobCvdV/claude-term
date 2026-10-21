// Talk to a running claude-term over the Chrome DevTools Protocol (see
// scripts/dev-instance.sh). Windows are picked by a regex on their title or address.
//   node scripts/cdp.mjs list [port]
//   node scripts/cdp.mjs eval <title> <js> [port]          → prints the (awaited) result
//   node scripts/cdp.mjs shot <title> <out.png> [js] [port] → optional js first, then a screenshot
//   node scripts/cdp.mjs type <title> <text> [port]        → types into the focused terminal (+Enter)
//   node scripts/cdp.mjs key <title> <combo> [port]        → one key press, e.g. ctrl+Space, meta+Enter
// Env: WAIT_MS delays before acting (let lookups settle).
import { writeFileSync } from 'fs'

const [cmd, ...rest] = process.argv.slice(2)
const isPort = (s) => /^\d{4,5}$/.test(s ?? '')
const port = isPort(rest.at(-1)) ? rest.pop() : '9340'

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
if (cmd === 'list') {
  for (const t of targets) if (t.type === 'page') console.log(t.title)
  process.exit(0)
}

// title or address: a window still loading has no title yet
const page = targets.find(
  (t) => t.type === 'page' && (new RegExp(rest[0]).test(t.title) || new RegExp(rest[0]).test(t.url))
)
if (!page) {
  console.error(`no window matches /${rest[0]}/ — open: ${targets.map((t) => t.title).join(' | ')}`)
  process.exit(1)
}

const sock = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    const onMsg = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== i) return
      sock.removeEventListener('message', onMsg)
      d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result)
    }
    sock.addEventListener('message', onMsg)
    sock.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (js) => {
  const r = await send('Runtime.evaluate', {
    expression: js,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

sock.onopen = async () => {
  try {
    await sleep(Number(process.env.WAIT_MS || 0))
    if (cmd === 'eval') {
      console.log(JSON.stringify(await evaluate(rest[1]), null, 2))
    } else if (cmd === 'shot') {
      if (rest[2]) {
        console.log(JSON.stringify(await evaluate(rest[2])))
        await sleep(1200)
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(rest[1], Buffer.from(data, 'base64'))
      console.log(`saved ${rest[1]} (${page.title})`)
    } else if (cmd === 'type') {
      await evaluate("document.querySelector('.xterm-helper-textarea')?.focus()")
      await send('Input.insertText', { text: rest[1] })
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r'
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })
      console.log('typed')
    } else if (cmd === 'key') {
      // e.g. "ctrl+Space", "meta+Enter", "Escape" — sent to whatever has focus
      const parts = rest[1].split('+')
      const key = parts.pop()
      const mods = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
      const modifiers = parts.reduce((m, p) => m | (mods[p.toLowerCase()] ?? 0), 0)
      const code =
        key === ' ' || key === 'Space'
          ? 'Space'
          : key.length === 1
            ? `Key${key.toUpperCase()}`
            : key
      const k = key === 'Space' ? ' ' : key
      const vk =
        {
          Space: 32,
          Enter: 13,
          Escape: 27,
          Tab: 9,
          ArrowUp: 38,
          ArrowDown: 40,
          ArrowLeft: 37,
          ArrowRight: 39
        }[code] ?? k.toUpperCase().charCodeAt(0)
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          modifiers,
          key: k,
          code,
          windowsVirtualKeyCode: vk
        })
      }
      console.log('sent', rest[1])
    } else {
      throw new Error(`unknown command ${cmd}`)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  }
  process.exit()
}
