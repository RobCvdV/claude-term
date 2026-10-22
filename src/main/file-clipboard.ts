import { clipboard } from 'electron'
import { execFile } from 'child_process'
import { cpSync, existsSync, statSync } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'
import type { PasteResult } from '../shared/types'
import { insideAny } from './file-tree'

/** Files on the system clipboard, the way Finder puts them there and takes them
 *  off: the file window's ⌘C and ⌘V work with Finder in both directions. */

// NSPasteboard via AppleScriptObjC: Electron's clipboard can only write one
// format, and Finder needs file URLs it can paste.
const WRITE_SCRIPT = `use framework "AppKit"
on run argv
  set urls to current application's NSMutableArray's new()
  repeat with p in argv
    (urls's addObject:(current application's NSURL's fileURLWithPath:(p as text)))
  end repeat
  set pb to current application's NSPasteboard's generalPasteboard()
  pb's clearContents()
  pb's writeObjects:urls
end run`

const READ_SCRIPT = `use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
set opts to current application's NSDictionary's dictionaryWithObject:true forKey:(current application's NSPasteboardURLReadingFileURLsOnlyKey)
set urls to pb's readObjectsForClasses:{current application's NSURL} options:opts
if urls is missing value then return ""
set out to {}
repeat with u in urls
  set end of out to (u's |path|() as text)
end repeat
set AppleScript's text item delimiters to linefeed
return out as text`

const osascript = (script: string, args: string[] = []): Promise<string | null> =>
  new Promise((done) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 5000 }, (err, stdout) =>
      done(err ? null : stdout)
    )
  })

/** Put `path` on the clipboard as a file (its path as text off macOS). */
export async function copyFile(path: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    clipboard.writeText(path)
    return true
  }
  return (await osascript(WRITE_SCRIPT, [path])) !== null
}

/** The files on the clipboard, as absolute paths. */
async function clipboardFiles(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  const out = await osascript(READ_SCRIPT)
  return (out ?? '').split('\n').filter((p) => p.startsWith('/'))
}

/** Finder's name for a copy that would clash: `a copy.ts`, then `a copy 2.ts`. */
export function freeName(
  dir: string,
  name: string,
  exists: (path: string) => boolean = existsSync
): string {
  if (!exists(join(dir, name))) return name
  // a dotfile's leading dot is its name, not an extension
  const ext = name.startsWith('.') && extname(name) === name ? '' : extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`
    if (!exists(join(dir, candidate))) return candidate
  }
}

/** Copy `sources` into `dir`, never overwriting. `dir` must be inside `roots`. */
export function pasteFiles(roots: string[], dir: string, sources: string[]): PasteResult {
  if (!insideAny(roots, dir)) return { ok: false, error: 'That folder is outside this project' }
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, error: 'Not a folder' }
  } catch {
    return { ok: false, error: 'That folder no longer exists' }
  }
  if (!sources.length) return { ok: false, error: 'No files on the clipboard' }
  const target = resolve(dir)
  const paths: string[] = []
  for (const src of sources.map((s) => resolve(s))) {
    if (target === src || target.startsWith(src + sep)) {
      return { ok: false, error: `Can't paste ${basename(src)} into itself` }
    }
    const dest = join(target, freeName(target, basename(src)))
    try {
      cpSync(src, dest, { recursive: true, errorOnExist: true, force: false })
    } catch (e) {
      return { ok: false, error: `Couldn't copy ${basename(src)}: ${(e as Error).message}` }
    }
    paths.push(dest)
  }
  return { ok: true, paths }
}

/** Paste whatever files the clipboard holds into `dir`. */
export async function pasteFromClipboard(roots: string[], dir: string): Promise<PasteResult> {
  return pasteFiles(roots, dir, await clipboardFiles())
}
