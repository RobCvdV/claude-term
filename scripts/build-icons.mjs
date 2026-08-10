// Regenerate every app icon from build/icon.svg (the single source of truth):
//   build/icon.icns  (macOS, via iconutil — skipped off-macOS)
//   build/icon.ico   (Windows, PNG-compressed entries)
//   build/icon.png   (Linux / electron-builder fallback, 1024px)
//   resources/icon.png (Linux BrowserWindow icon, 512px)
// Rasterizing needs librsvg: brew install librsvg
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SVG = 'build/icon.svg'
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

try {
  execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' })
} catch {
  console.error('rsvg-convert not found — install it with: brew install librsvg')
  process.exit(1)
}

const render = (size, out) =>
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, SVG])

/** .ico container with PNG-compressed entries (valid since Windows Vista). */
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bit depth
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
    blobs.push(data)
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

const tmp = mkdtempSync(join(tmpdir(), 'claude-term-icons-'))
try {
  render(1024, 'build/icon.png')
  render(512, 'resources/icon.png')
  console.log('✓ build/icon.png (1024), resources/icon.png (512)')

  const icoPngs = ICO_SIZES.map((size) => {
    const p = join(tmp, `ico-${size}.png`)
    render(size, p)
    return { size, data: readFileSync(p) }
  })
  writeFileSync('build/icon.ico', buildIco(icoPngs))
  console.log(`✓ build/icon.ico (${ICO_SIZES.join(', ')})`)

  if (process.platform === 'darwin') {
    const set = join(tmp, 'icon.iconset')
    mkdirSync(set)
    for (const [name, size] of ICONSET) render(size, join(set, name))
    execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns'])
    console.log('✓ build/icon.icns')
  } else {
    console.log('- icon.icns skipped (needs macOS iconutil)')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
