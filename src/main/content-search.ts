/** Searching inside the project's files, for the file window's filter box in
 *  its "in files" mode.
 *
 *  Files are read in fixed-size chunks, so memory stays flat however big a
 *  file is; only text files are searched — binaries are skipped by extension,
 *  and anything else by a NUL byte in its first chunk. */

import { open, stat } from 'fs/promises'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { ContentSearch, LineHit } from '../shared/types'
import { listFiles } from './completions'

const CHUNK = 64 * 1024
/** A search reads every byte, so a log or a dump costs time, not memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** A line longer than this (minified code) is searched without keeping it whole. */
const MAX_LINE = 64 * 1024
const MAX_HITS = 300
const MAX_HITS_PER_FILE = 20
const PARALLEL = 8
const PREVIEW_BEFORE = 30
const PREVIEW_LEN = 160

const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif webp avif bmp ico icns tif tiff psd heic raw cr2 nef ' +
    'mp3 wav ogg oga flac m4a aac aiff wma opus mid midi ' +
    'mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp ' +
    'zip gz tgz bz2 xz 7z rar zst lz4 tar jar war ear apk aab ipa dmg iso pkg deb rpm ' +
    'pdf doc docx xls xlsx ppt pptx odt ods odp pages numbers key ' +
    'woff woff2 ttf otf eot ' +
    'exe dll so dylib a o obj lib class pyc pyo wasm node bin dat ' +
    'db sqlite sqlite3 mdb realm ' +
    'keystore jks p12 pfx der cer ' +
    'dcu bpl dcp res'
  ).split(' ')
)

/** A file type that is never text, judged by its name alone. */
export function isBinaryName(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 && BINARY_EXT.has(base.slice(dot + 1))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The match's line cut down to a row: a little before the match, the rest after. */
function previewOf(
  line: string,
  at: number,
  length: number
): Omit<LineHit, 'line' | 'column' | 'length'> {
  const start = Math.max(0, at - PREVIEW_BEFORE)
  const lead = (start > 0 ? '…' : '') + line.slice(start, at).trimStart()
  const after = line.slice(at + length, at + Math.max(length, PREVIEW_LEN - lead.length)).trimEnd()
  return { preview: lead + line.slice(at, at + length) + after, previewAt: lead.length }
}

/**
 * The lines of `path` matching `re` (global, case-insensitive), first match
 * per line. Null for a binary file. `chunk` is only smaller in tests, to put
 * lines across chunk edges.
 */
export async function searchFile(
  path: string,
  re: RegExp,
  maxHits: number,
  isCancelled: () => boolean = () => false,
  chunk = CHUNK
): Promise<LineHit[] | null> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(chunk)
    const decoder = new StringDecoder('utf8')
    const hits: LineHit[] = []
    // the current line: its number, what a cut long line dropped from its
    // start, and whether it has its hit already
    let line = 1
    let dropped = 0
    let lineHit = false
    const newline = (): void => {
      line++
      dropped = 0
      lineHit = false
    }
    let carry = ''
    for (let first = true; ; first = false) {
      if (isCancelled()) return hits
      const { bytesRead } = await fh.read(buf, 0, chunk, null)
      if (first && buf.subarray(0, bytesRead).includes(0)) return null
      const eof = bytesRead === 0
      const text = carry + (eof ? decoder.end() : decoder.write(buf.subarray(0, bytesRead)))
      const end = eof ? text.length : text.lastIndexOf('\n')

      if (end < 0) {
        // one long line so far: search it now, keep only enough to catch a
        // match straddling the cut
        carry = text
        if (text.length > MAX_LINE) {
          re.lastIndex = 0
          const m = lineHit ? null : re.exec(text)
          if (m) {
            hits.push({
              line,
              column: dropped + m.index + 1,
              length: m[0].length,
              ...previewOf(text, m.index, m[0].length)
            })
            lineHit = true
          }
          carry = text.slice(text.length - re.source.length)
          dropped += text.length - carry.length
        }
        continue
      }

      // one regex scan over the complete lines, counting newlines up to each match
      let lineStart = 0
      let counted = 0
      const countTo = (to: number): void => {
        for (let i = text.indexOf('\n', counted); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) {
          newline()
          lineStart = i + 1
        }
        counted = to
      }
      re.lastIndex = 0
      while (hits.length < maxHits) {
        const m = re.exec(text)
        if (!m || m.index >= end) break
        countTo(m.index)
        let lineEnd = text.indexOf('\n', m.index)
        if (lineEnd < 0 || lineEnd > end) lineEnd = end
        if (!lineHit) {
          const at = m.index - lineStart
          const lineText = text.slice(lineStart, lineEnd)
          hits.push({
            line,
            column: dropped + at + 1,
            length: m[0].length,
            ...previewOf(lineText, at, m[0].length)
          })
          lineHit = true
        }
        if (lineEnd >= end) break
        re.lastIndex = lineEnd
      }
      if (hits.length >= maxHits || eof) return hits
      countTo(end)
      // `end` is a newline: what follows starts the next line
      newline()
      carry = text.slice(end + 1)
    }
  } finally {
    await fh.close()
  }
}

/**
 * Text files under `roots` containing `query` (case-insensitive, taken
 * literally), first match per line. Empty for an empty query.
 */
export async function searchContents(
  roots: string[],
  query: string,
  isCancelled: () => boolean = () => false
): Promise<ContentSearch> {
  const result: ContentSearch = { matches: [], truncated: false, skippedLarge: 0 }
  if (!query.trim()) return result
  const files: Array<{ path: string; name: string }> = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const rel of await listFiles(root)) {
      const path = join(root, rel)
      if (seen.has(path) || isBinaryName(rel)) continue
      seen.add(path)
      files.push({ path, name: rel })
    }
  }
  let total = 0
  let next = 0
  const worker = async (): Promise<void> => {
    const re = new RegExp(escapeRe(query), 'gi')
    while (next < files.length && !isCancelled()) {
      if (total >= MAX_HITS) {
        result.truncated = true
        return
      }
      const file = files[next++]
      try {
        const { size, isFile } = await stat(file.path).then((s) => ({
          size: s.size,
          isFile: s.isFile()
        }))
        if (!isFile) continue
        if (size > MAX_FILE_BYTES) {
          result.skippedLarge++
          continue
        }
        const room = Math.max(1, Math.min(MAX_HITS_PER_FILE, MAX_HITS - total))
        const hits = await searchFile(file.path, re, room, isCancelled)
        if (!hits?.length) continue
        total += hits.length
        result.matches.push({ ...file, size, hits })
      } catch {
        // vanished or unreadable since the listing — nothing to find in it
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  result.matches.sort((a, b) => a.name.localeCompare(b.name))
  return result
}
