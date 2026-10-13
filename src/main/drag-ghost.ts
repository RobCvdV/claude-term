import { BrowserWindow } from 'electron'

const HEIGHT = 32
/** where the cursor sits on the ghost: a little in from its left edge, mid-height */
const GRAB_X = 24

let ghost: BrowserWindow | null = null
let shown = false

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Inline page for the ghost: the tab as a floating pill. */
function ghostPage(title: string, color: string | null): string {
  const accent = color ?? '#e6e6ea'
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}
.pill{box-sizing:border-box;height:${HEIGHT}px;display:flex;align-items:center;gap:8px;
padding:0 12px;border-radius:6px;background:rgba(35,36,40,.92);border:1px solid ${accent};
color:#d4d4d8;font:12px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:${accent}}
</style><div class="pill"><span class="dot"></span>${escapeHtml(title)}</div>`
}

/**
 * A tab being dragged out of its window. The DOM can't draw past the window's
 * edge, so a frameless, click-through window follows the cursor instead.
 */
export function showDragGhost(title: string, color: string | null, width: number): void {
  hideDragGhost()
  ghost = new BrowserWindow({
    width: Math.round(Math.min(280, Math.max(120, width))),
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  ghost.setAlwaysOnTop(true, 'pop-up-menu')
  ghost.setIgnoreMouseEvents(true)
  shown = false
  void ghost.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ghostPage(title, color))}`)
}

export function moveDragGhost(x: number, y: number): void {
  if (!ghost || ghost.isDestroyed()) return
  ghost.setPosition(Math.round(x - GRAB_X), Math.round(y - HEIGHT / 2))
  if (!shown) {
    shown = true
    ghost.showInactive()
  }
}

export function hideDragGhost(): void {
  if (ghost && !ghost.isDestroyed()) ghost.destroy()
  ghost = null
  shown = false
}
