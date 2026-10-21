import { describe, expect, it } from 'vitest'
import { cleanCompletion, completionPrompt, PREFIX_CHARS } from './completion-text'

describe('completionPrompt', () => {
  it('wraps the cursor context and clips long sides', () => {
    const long = 'x'.repeat(PREFIX_CHARS + 10)
    const p = completionPrompt('src/a.ts', long, 'after')
    expect(p.startsWith('File: src/a.ts\n<prefix>')).toBe(true)
    expect(p).toContain('</prefix><suffix>after</suffix>')
    expect(p.length).toBeLessThan(PREFIX_CHARS + 60)
  })
})

describe('cleanCompletion', () => {
  it('drops a wrapping code fence and trailing whitespace', () => {
    expect(cleanCompletion('```ts\nreturn 1\n```\n', '  ')).toBe('return 1')
  })

  it('drops an echo of the line typed so far', () => {
    expect(cleanCompletion('const x = 42', 'foo\nconst x')).toBe(' = 42')
  })

  it('keeps a leading newline only when the cursor is mid-line', () => {
    expect(cleanCompletion('\nnext()', 'a();')).toBe('\nnext()')
    expect(cleanCompletion('\nnext()', 'a();\n')).toBe('next()')
  })
})
