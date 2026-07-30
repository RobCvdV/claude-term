// Harper (grammar) off the main thread. LocalLinter, not WorkerLinter: we are
// already inside a worker, so letting harper.js spawn another one would only add
// a hop. The wasm arrives as bytes from the main process (see the grammar:wasm
// IPC handler) because the packaged app runs from file://, where fetch is blocked.
import { createBinaryModuleFromUrl, LocalLinter, type Linter } from 'harper.js'
import type { Finding, WorkerRequest, WorkerResponse } from './protocol'

let linter: Linter | null = null

function post(message: WorkerResponse): void {
  self.postMessage(message)
}

async function init(wasm: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }))
  try {
    const binary = createBinaryModuleFromUrl(url, 'full')
    const local = new LocalLinter({ binary })
    await local.setup()
    linter = local
  } finally {
    // harper has the module compiled by now; don't hold 15MB hostage
    URL.revokeObjectURL(url)
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data
  if (msg.type === 'init') {
    try {
      await init(msg.wasm)
      post({ type: 'ready', ok: true })
    } catch {
      post({ type: 'ready', ok: false })
    }
    return
  }
  if (!linter) {
    post({ type: 'linted', id: msg.id, findings: [] })
    return
  }
  // markdown: harper parses it itself, so code fences, inline code and link
  // targets are skipped without us masking anything.
  // isolateEnglish: only lint the parts it believes are English — the docs here
  // mix in Dutch, and English grammar rules on Dutch prose are pure noise.
  const lints = await linter.lint(msg.text, {
    language: 'markdown',
    isolateEnglish: true,
    dedup: true
  })
  const findings: Finding[] = lints.map((lint) => {
    const span = lint.span()
    return {
      start: span.start,
      end: span.end,
      kind: lint.lint_kind(),
      message: lint.message(),
      replacements: lint.suggestions().map((s) => s.get_replacement_text())
    }
  })
  post({ type: 'linted', id: msg.id, findings })
}
