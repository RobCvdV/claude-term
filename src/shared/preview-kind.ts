/** How the file window's View shows a file, by its type. Files with none have
 *  nothing to show beyond their text, so they only get the editor. */
export type PreviewKind = 'markdown' | 'image' | 'html'

/** Image types by extension, with the MIME type a data URL needs. */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function previewKind(path: string): PreviewKind | null {
  const ext = extOf(path)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (IMAGE_MIME[ext]) return 'image'
  if (ext === 'html' || ext === 'htm') return 'html'
  return null
}

/** An image that is not text: shown, never edited. SVG is both. */
export function isBinaryImage(path: string): boolean {
  const ext = extOf(path)
  return !!IMAGE_MIME[ext] && ext !== 'svg'
}

/** The MIME type of an image file, if it is one. */
export function imageMime(path: string): string | undefined {
  return IMAGE_MIME[extOf(path)]
}
