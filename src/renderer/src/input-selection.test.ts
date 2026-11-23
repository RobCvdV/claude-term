import { describe, expect, it } from 'vitest'
import {
  promptRow,
  cellRun,
  deleteSpan,
  moveCaret,
  selectedText,
  selectMove,
  span,
  type Cell,
  type InputScreen
} from './input-selection'

/** Claude Code's input as rows: "❯ " then the text, wrapped at `width`, newlines
 *  starting a row of their own, continuation rows indented two. */
function fakeInput(text: string, caret: number, width = 10): InputScreen & { text: () => string } {
  let t = text
  let at = caret
  const layout = (): { rows: string[]; cells: Cell[] } => {
    const rows: string[] = []
    const cells: Cell[] = []
    let row = ''
    let col = 0
    const flush = (): void => {
      rows.push((rows.length ? '  ' : '❯ ') + row)
      row = ''
      col = 0
    }
    for (let i = 0; i <= t.length; i++) {
      if (col === width && i < t.length && t[i] !== '\n') flush()
      cells.push({ x: 2 + col, y: rows.length })
      if (i === t.length) break
      if (t[i] === '\n') flush()
      else {
        row += t[i]
        col++
      }
    }
    flush()
    return { rows, cells }
  }
  return {
    text: () => t,
    cursor: () => layout().cells[at],
    row: (y) => layout().rows[y] ?? '',
    settled: () => Promise.resolve(),
    send: (data) => {
      const keys: string[] = []
      for (let i = 0; i < data.length; i++) {
        const csi = data.startsWith('\x1b[', i)
        keys.push(csi ? data.slice(i, i + 3) : data[i])
        if (csi) i += 2
      }
      for (const key of keys) {
        if (key === '\x1b[D') at = Math.max(0, at - 1)
        else if (key === '\x1b[C') at = Math.min(t.length, at + 1)
        else if (key === '\x7f' && at > 0) {
          t = t.slice(0, at - 1) + t.slice(at)
          at--
        }
      }
    }
  }
}

describe('selectMove', () => {
  const k = (
    key: string,
    mods: Record<string, boolean> = {}
  ): Parameters<typeof selectMove>[0] => ({
    key,
    shiftKey: true,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    ...mods
  })
  it('maps ⇧ with arrows and modifiers', () => {
    expect(selectMove(k('ArrowLeft'))).toBe('left')
    expect(selectMove(k('ArrowRight', { altKey: true }))).toBe('wordRight')
    expect(selectMove(k('ArrowLeft', { metaKey: true }))).toBe('lineStart')
  })
  it('leaves ⇧↑ ⇧↓ and unshifted keys to Claude Code', () => {
    expect(selectMove(k('ArrowUp'))).toBeNull()
    expect(selectMove(k('ArrowLeft', { shiftKey: false }))).toBeNull()
    expect(selectMove(k('ArrowLeft', { ctrlKey: true }))).toBeNull()
  })
})

describe('selection geometry', () => {
  it('orders the ends and runs across rows', () => {
    const a = { x: 5, y: 1 }
    const c = { x: 3, y: 0 }
    expect(span(a, c)).toEqual([c, a])
    expect(cellRun(a, c, 80)).toEqual({ x: 3, y: 0, length: 82 })
  })

  it('reads the selected text without the indent', () => {
    const s = fakeInput('hello\nnext line', 0)
    expect(selectedText(s, { x: 4, y: 1 }, { x: 4, y: 0 })).toBe('llo\nne')
  })
})

describe('promptRow', () => {
  it('finds the ❯ row above a wrapped caret, and nothing elsewhere', () => {
    const rows = ['output', '❯ hello', '  world', '─────']
    const row = (y: number): string => rows[y] ?? ''
    expect(promptRow(row, 2)).toBe(1)
    expect(promptRow(row, 1)).toBe(1)
    expect(promptRow(row, 3)).toBeNull()
  })
})

describe('moveCaret', () => {
  it('walks across rows to the target', async () => {
    const s = fakeInput('one\ntwo three four', 0)
    expect(await moveCaret(s, { x: 5, y: 2 })).toBe(true)
    expect(s.cursor()).toEqual({ x: 5, y: 2 })
    expect(await moveCaret(s, { x: 3, y: 0 })).toBe(true)
  })
})

describe('deleteSpan', () => {
  it('deletes within a row', async () => {
    const s = fakeInput('alpha beta', 10)
    expect(await deleteSpan(s, { x: 8, y: 0 }, { x: 12, y: 0 })).toBe(true)
    expect(s.text()).toBe('alpha ')
  })

  it('deletes across a newline and a wrap, caret starting at either end', async () => {
    const forward = fakeInput('one\ntwo three four', 1)
    await deleteSpan(forward, { x: 3, y: 0 }, { x: 4, y: 2 })
    expect(forward.text()).toBe('our')

    const backward = fakeInput('one\ntwo three four', 1)
    // caret at the start, the selection running right
    await deleteSpan(backward, { x: 3, y: 0 }, { x: 4, y: 2 })
    expect(backward.text()).toBe('our')
  })

  it('never deletes before the start', async () => {
    const s = fakeInput('abcdefghij klm', 14)
    await deleteSpan(s, { x: 12, y: 0 }, { x: 6, y: 1 })
    expect(s.text()).toBe('abcdefghij')
  })
})
