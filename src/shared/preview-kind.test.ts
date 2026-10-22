import { describe, expect, it } from 'vitest'
import { imageMime, isBinaryImage, previewKind } from './preview-kind'

describe('previewKind', () => {
  it('previews markdown, images and html by extension, ignoring case', () => {
    expect(previewKind('/r/README.md')).toBe('markdown')
    expect(previewKind('/r/logo.SVG')).toBe('image')
    expect(previewKind('/r/shot.png')).toBe('image')
    expect(previewKind('/r/index.html')).toBe('html')
  })

  it('has nothing to preview for code and extensionless files', () => {
    expect(previewKind('/r/a.ts')).toBeNull()
    expect(previewKind('/r/Makefile')).toBeNull()
    expect(previewKind('/r/.png')).toBeNull()
  })
})

describe('isBinaryImage', () => {
  it('is true for raster images, not for SVG, which is text', () => {
    expect(isBinaryImage('/r/a.jpg')).toBe(true)
    expect(isBinaryImage('/r/a.svg')).toBe(false)
    expect(isBinaryImage('/r/a.md')).toBe(false)
  })

  it('knows the MIME type', () => {
    expect(imageMime('/r/a.jpeg')).toBe('image/jpeg')
    expect(imageMime('/r/a.ts')).toBeUndefined()
  })
})
