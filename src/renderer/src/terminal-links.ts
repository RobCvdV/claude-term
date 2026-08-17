import type { IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findFileLinks } from '../../shared/file-link'

/**
 * Cmd-clickable `src/main/ipc.ts:403` in terminal output. Not built on
 * WebLinksAddon despite its `urlRegex` option: it runs every match through
 * `new URL()` and drops whatever isn't a URL, so a file path never survives.
 */

/** A rendered line as text, plus the cell each character came from — wide
 *  glyphs and combining marks make string offsets and columns diverge. */
export interface LineCells {
  text: string
  /** cellOf[i] = 0-based column of text[i] */
  cellOf: number[]
}

export function readLineCells(line: IBufferLine, cols: number): LineCells {
  let text = ''
  const cellOf: number[] = []
  const reused = line.getCell(0)
  for (let x = 0; x < cols; x++) {
    const cell = reused ? line.getCell(x, reused) : line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue // the trailing half of a wide glyph
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) cellOf.push(x)
    text += chars
  }
  return { text, cellOf }
}

/** The file links in one buffer line, as xterm ranges (1-based, end inclusive). */
export function fileLinksInLine(
  line: IBufferLine,
  cols: number,
  y: number
): { range: IBufferRange; text: string }[] {
  const { text, cellOf } = readLineCells(line, cols)
  return findFileLinks(text).map((span) => ({
    text: span.raw,
    range: {
      start: { x: cellOf[span.start] + 1, y },
      end: { x: cellOf[span.end - 1] + 1, y }
    }
  }))
}

export function fileLinkProvider(term: Terminal, open: (raw: string) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const links: ILink[] = fileLinksInLine(line, term.cols, y).map((link) => ({
        ...link,
        decorations: { pointerCursor: true, underline: true },
        // Cmd/Ctrl-click like the URL links, so a plain drag still selects text
        activate: (event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey) open(link.text)
        }
      }))
      callback(links.length ? links : undefined)
    }
  }
}
