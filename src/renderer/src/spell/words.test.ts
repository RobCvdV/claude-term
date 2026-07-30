import { describe, expect, it } from 'vitest'
import { extractWords, type SpellMode } from './words'

const words = (text: string, mode: SpellMode = 'prompt'): string[] =>
  extractWords(text, mode).map((h) => h.word)

describe('extractWords', () => {
  it('returns plain prose words with 1-based positions', () => {
    expect(extractWords('hello wolrd', 'prompt')).toEqual([
      { line: 1, column: 1, word: 'hello' },
      { line: 1, column: 7, word: 'wolrd' }
    ])
  })

  it('counts lines from one', () => {
    expect(extractWords('one\n\nthree', 'prompt')).toEqual([
      { line: 1, column: 1, word: 'one' },
      { line: 3, column: 1, word: 'three' }
    ])
  })

  it('keeps contractions whole and splits on hyphens', () => {
    expect(words("don't spell-check")).toEqual(["don't", 'spell', 'check'])
  })

  it('skips code-ish chunks', () => {
    const text = 'see src/main/ipc.ts and getFoo() plus utf8 and MTX-10302 and snake_case'
    expect(words(text)).toEqual(['see', 'and', 'plus', 'and', 'and'])
  })

  it('skips acronyms, camelCase and words under three letters', () => {
    expect(words('the API in PromptBox is okay')).toEqual(['the', 'okay'])
  })

  it('skips urls and @mentions but keeps the prose around them', () => {
    expect(words('check https://example.com/a and @src/renderer now')).toEqual([
      'check',
      'and',
      'now'
    ])
  })

  it('skips a leading slash command only on the first line', () => {
    expect(words('/switch feature\n/notacommand here')).toEqual(['feature', 'notacommand', 'here'])
  })

  it('ignores fenced code blocks in markdown', () => {
    const md = ['prose here', '```ts', 'const wolrd = 1', '```', 'more prose'].join('\n')
    expect(words(md, 'markdown')).toEqual(['prose', 'here', 'more', 'prose'])
  })

  it('ignores inline code and link targets in markdown', () => {
    const md = 'use `npm run dev` then see [the docs](./doc/setup-guide.md) ok'
    expect(words(md, 'markdown')).toEqual(['use', 'then', 'see', 'the', 'docs'])
  })

  it('checks words inside markdown emphasis and headings', () => {
    expect(words('## The **bold** heading', 'markdown')).toEqual(['The', 'bold', 'heading'])
  })

  it('handles accented and Dutch words', () => {
    expect(words('een café zoëven')).toEqual(['een', 'café', 'zoëven'])
  })
})
