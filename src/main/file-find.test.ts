import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findFiles } from './file-find'

let root: string
let other: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'find-root-'))
  other = mkdtempSync(join(tmpdir(), 'find-added-'))
  mkdirSync(join(root, 'docs/deep'), { recursive: true })
  for (const rel of [
    'README.md',
    'Makefile',
    'docs/notes',
    'docs/plan.md',
    'docs/deep/plan-b.md',
    'src/thing.ts'
  ]) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), 'x'.repeat(rel.length))
  }
  writeFileSync(join(other, 'shared.md'), 'hello')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

describe('findFiles', () => {
  it('finds a file the rail never lists — no extension at all', async () => {
    const hits = await findFiles([root], 'notes')
    expect(hits.map((h) => h.name)).toEqual(['docs/notes'])
    expect(hits[0].path).toBe(join(root, 'docs/notes'))
    expect(hits[0]).toMatchObject({ isDir: false, size: 'docs/notes'.length })
  })

  it('takes a * pattern, over the path and over the file name', async () => {
    expect((await findFiles([root], '*.md')).map((h) => h.name)).toEqual([
      'README.md',
      'docs/plan.md',
      'docs/deep/plan-b.md'
    ])
    expect((await findFiles([root], 'plan*')).map((h) => h.name)).toEqual([
      'docs/plan.md',
      'docs/deep/plan-b.md'
    ])
  })

  it('searches added directories too, and never lists one file twice', async () => {
    const hits = await findFiles([root, other, other], 'shared')
    expect(hits.map((h) => h.path)).toEqual([join(other, 'shared.md')])
  })

  it('puts the shortest path first, so the plainest match leads', async () => {
    const hits = await findFiles([root], 'plan')
    expect(hits.map((h) => h.name)).toEqual(['docs/plan.md', 'docs/deep/plan-b.md'])
  })

  it('finds nothing for an empty query — the rail is showing itself', async () => {
    expect(await findFiles([root], '')).toEqual([])
    expect(await findFiles([root], '   ')).toEqual([])
  })

  it('is empty, not an error, when a root cannot be read', async () => {
    expect(await findFiles([join(root, 'gone')], 'plan')).toEqual([])
  })
})
