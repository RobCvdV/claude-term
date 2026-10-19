import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown tables', () => {
  it('renders a GFM table with header, rows and inline markup', () => {
    const md = [
      '| Label | Kind | Meaning |',
      '|---|---|---|',
      '| A | logging | adds **evidence** |',
      '| B | fixes | `x | y` stays one cell |'
    ].join('\n')
    const html = renderMarkdown(md)
    expect(html).toContain(
      '<table><thead><tr><th>Label</th><th>Kind</th><th>Meaning</th></tr></thead>'
    )
    expect(html).toContain('<td>adds <strong>evidence</strong></td>')
    expect(html).toContain('<td><code>x | y</code> stays one cell</td>')
    expect(html.match(/<tr>/g)).toHaveLength(3)
  })

  it('honours alignment and pads short rows', () => {
    const html = renderMarkdown('a | b | c\n:-- | :-: | --:\n1 | 2')
    expect(html).toContain('<th style="text-align:left">a</th>')
    expect(html).toContain('<th style="text-align:center">b</th>')
    expect(html).toContain('<td style="text-align:right"></td>')
  })

  it('ends a paragraph where a table starts, and leaves lone pipes alone', () => {
    const html = renderMarkdown('Intro text\n| a | b |\n|---|---|\n| 1 | 2 |\n\nx | y in prose')
    expect(html).toMatch(/^<p>Intro text<\/p>\n<table>/)
    expect(html).toContain('<p>x | y in prose</p>')
  })

  it('escapes HTML inside cells', () => {
    expect(renderMarkdown('| a |\n|---|\n| <b>x</b> |')).toContain('<td>&lt;b&gt;x&lt;/b&gt;</td>')
  })
})
