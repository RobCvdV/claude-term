import { describe, expect, it } from 'vitest'
import type { IBufferLine } from '@xterm/xterm'
import { fileLinksInLine, readLineCells } from './terminal-links'

/** A buffer line built from cells. A plain string is one single-width cell,
 *  `[chars, width]` a wider one, and `null` the zero-width tail xterm puts in
 *  the second cell of a wide glyph. */
type Cell = string | null | [string, number]

function lineOf(cells: Cell[]): IBufferLine {
  const cell = (c: Cell): unknown => {
    const [chars, width] = c === null ? ['', 0] : typeof c === 'string' ? [c, 1] : c
    return { getChars: () => chars, getWidth: () => width }
  }
  return {
    getCell: (x: number) => (x < cells.length ? cell(cells[x]) : undefined)
  } as unknown as IBufferLine
}

const fromText = (text: string): IBufferLine => lineOf([...text])

describe('readLineCells', () => {
  it('maps every character back to its column', () => {
    const { text, cellOf } = readLineCells(fromText('ab'), 80)
    expect(text).toBe('ab')
    expect(cellOf).toEqual([0, 1])
  })

  it('skips the zero-width tail of a wide glyph', () => {
    const { text, cellOf } = readLineCells(lineOf([['✅', 2], null, 'a']), 80)
    expect(text).toBe('✅a')
    expect(cellOf).toEqual([0, 2])
  })

  it('reads an empty cell as a space', () => {
    expect(readLineCells(lineOf(['a', '', 'b']), 80).text).toBe('a b')
  })
})

describe('fileLinksInLine', () => {
  it('gives a 1-based, end-inclusive range for the match', () => {
    expect(fileLinksInLine(fromText('see a/b.ts:12 now'), 80, 5)).toEqual([
      { text: 'a/b.ts:12', range: { start: { x: 5, y: 5 }, end: { x: 13, y: 5 } } }
    ])
  })

  it('shifts columns past a wide glyph, so the underline lands on the path', () => {
    const line = lineOf([['✅', 2], null, ' ', ...'a/b.ts:1'])
    expect(fileLinksInLine(line, 80, 1)).toEqual([
      { text: 'a/b.ts:1', range: { start: { x: 4, y: 1 }, end: { x: 11, y: 1 } } }
    ])
  })

  it('finds every link on the line', () => {
    expect(fileLinksInLine(fromText('a.ts:1 b.ts:2'), 80, 2).map((l) => l.text)).toEqual([
      'a.ts:1',
      'b.ts:2'
    ])
  })

  it('returns nothing for a line without one', () => {
    expect(fileLinksInLine(fromText('all tests passed'), 80, 1)).toEqual([])
  })
})
