/** Finding `src/main/ipc.ts:403` in terminal output. Pure text in, spans out —
 *  the terminal locates them, the main process resolves them against the tab's
 *  roots. */

export interface FileLink {
  /** exactly as it was printed: still relative, still `~`, never resolved */
  path: string
  line: number
  column?: number
}

/** A link and where it sits in the line it was found in (string offsets). */
export interface FileLinkSpan extends FileLink {
  /** the whole matched text, `path:line[:col]` */
  raw: string
  start: number
  /** exclusive */
  end: number
}

// One path segment. No spaces: a filename may legally contain one, but in
// terminal output a space is far more often the end of the path.
const SEG = String.raw`[A-Za-z0-9_.+@%~-]+`
// ./ ../ ~/ or / — each of which makes what follows unambiguously a path
const ROOTED = String.raw`(?:\.{1,2}/|~/|/)`
// An extension has to start with a letter, which is what keeps version numbers
// and clock times ("v1.34.0:12", "14:00:55") from reading as files.
const EXT = String.raw`\.[A-Za-z]\w{0,9}`

const PATH = [
  `${ROOTED}?${SEG}(?:/${SEG})+`, // holds a slash: src/main/ipc.ts, .claude/x
  `${ROOTED}${SEG}`, // rooted, so a bare name is still a path: ./Makefile
  `${SEG}${EXT}` // neither, so it must look like a file: App.tsx
].join('|')

// Not preceded by a path/word character (so a match never starts mid-path) and
// not by a colon or slash, which is what keeps `http://host:80/p` out.
const PATTERN = String.raw`(?<![\w:/.-])(${PATH}):(\d+)(?::(\d+))?(?![\w/])`

/** Every `path:line[:col]` in one line of terminal output, left to right. */
export function findFileLinks(text: string): FileLinkSpan[] {
  const re = new RegExp(PATTERN, 'g')
  const out: FileLinkSpan[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({
      raw: m[0],
      path: m[1],
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : undefined,
      start: m.index,
      end: m.index + m[0].length
    })
  }
  return out
}

/** The one link a string *is*, rather than contains. */
export function parseFileLink(text: string): FileLink | null {
  const m = new RegExp(`^${PATTERN}$`).exec(text.trim())
  if (!m) return null
  return { path: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined }
}
