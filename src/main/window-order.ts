import type {
  PersistedSession,
  PersistedSessionFile,
  PersistedWindow,
  TabId,
  WindowBounds
} from '../shared/types'

// Pure helpers behind the terminal-window registry — no electron, so testable.

export interface PlacedWindow {
  id: number
  bounds: WindowBounds
}

/** Left to right, then top to bottom — the order tabs are numbered across windows. */
export function spatialOrder<T extends PlacedWindow>(wins: readonly T[]): T[] {
  return [...wins].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id)
}

/** The window after `currentId` in `order`, wrapping; the first one when current isn't in it. */
export function nextWindowId(order: readonly number[], currentId: number | null): number | null {
  if (order.length === 0) return null
  const i = currentId === null ? -1 : order.indexOf(currentId)
  return order[(i + 1) % order.length] ?? null
}

/** The tab `delta` steps from `current` in the flattened list, wrapping. */
export function stepTabId(
  list: readonly TabId[],
  current: TabId | null,
  delta: number
): TabId | null {
  if (list.length === 0) return null
  const i = current ? list.indexOf(current) : -1
  if (i < 0) return list[0]
  return list[(((i + delta) % list.length) + list.length) % list.length]
}

/** Height of the tab bar a dropped tab can land on, in px from the content top. */
export const TAB_BAR_DROP_HEIGHT = 44

/** The window whose tab bar contains the screen point (content bounds given). */
export function windowAtTabBar(wins: readonly PlacedWindow[], x: number, y: number): number | null {
  const hit = wins.find(
    ({ bounds: b }) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + TAB_BAR_DROP_HEIGHT
  )
  return hit?.id ?? null
}

/** Saved bounds, only when enough of them is still on one of the displays. */
export function usableBounds(
  bounds: WindowBounds | undefined,
  displays: readonly WindowBounds[]
): WindowBounds | undefined {
  if (!bounds || bounds.width < 200 || bounds.height < 150) return undefined
  const visible = displays.some((d) => {
    const w = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x)
    const h = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y)
    return w >= 100 && h >= 50
  })
  return visible ? bounds : undefined
}

/** The windows a session file describes; an old single-window file is one window. */
export function windowsOf(file: PersistedSessionFile | null): PersistedWindow[] {
  if (!file) return []
  const wins = file.windows?.length
    ? file.windows
    : [{ tabs: file.tabs, activeIndex: file.activeIndex }]
  return wins.filter((w) => Array.isArray(w.tabs))
}

/** The session file for these windows, first window mirrored at the top level. */
export function sessionFileOf(windows: readonly PersistedWindow[]): PersistedSessionFile {
  const first: PersistedSession = windows[0] ?? { tabs: [], activeIndex: 0 }
  return { tabs: first.tabs, activeIndex: first.activeIndex, windows: [...windows] }
}
