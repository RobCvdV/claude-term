// node-pty ships a `spawn-helper` binary on macOS/Linux that must be executable;
// npm can drop the +x bit when unpacking. Restore it cross-platform. On Windows
// node-pty uses conpty/winpty (no spawn-helper), so this is a no-op there —
// which is exactly why this replaces the old unix-only `chmod` in postinstall.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const base = join('node_modules', 'node-pty', 'prebuilds')
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper')
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755)
      } catch {
        // best-effort: a read-only FS or missing file shouldn't fail install
      }
    }
  }
}
