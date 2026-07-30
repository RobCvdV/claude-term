// Harper's grammar engine is a 15MB WebAssembly blob. It can't ride the renderer
// bundle: the packaged app loads from file://, where fetch (and so
// WebAssembly.instantiateStreaming) is blocked, and harper.js resolves its own
// binary with `new URL(…, import.meta.url)`. So copy it next to the other
// runtime resources — electron-builder unpacks `resources/**` out of the asar,
// and main reads the bytes from there and hands them to the renderer.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const source = join('node_modules', 'harper.js', 'dist', 'harper_wasm_bg.wasm')
const dest = join('resources', 'harper-grammar.wasm')

if (existsSync(source)) {
  try {
    mkdirSync('resources', { recursive: true })
    copyFileSync(source, dest)
  } catch {
    // best-effort: grammar checking stays off if the copy fails, the app runs
  }
}
