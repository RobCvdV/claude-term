/** Pure geometry helpers for drag-reordering the tab bar. */

/** New array with the item at `from` moved to index `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Slot the tab dragged from `from` currently occupies: it takes over a
 * neighbour's slot once its centre passes that neighbour's centre. `centers`
 * are the tab centres measured when the drag started, `center` the dragged
 * tab's live centre.
 */
export function dropIndex(centers: number[], from: number, center: number): number {
  if (from < 0 || from >= centers.length) return from
  let to = from
  while (to + 1 < centers.length && center > centers[to + 1]) to++
  while (to - 1 >= 0 && center < centers[to - 1]) to--
  return to
}

/** Pixels a non-dragged tab at `i` slides while the drag runs from → to. */
export function shiftFor(i: number, from: number, to: number, width: number): number {
  if (from < to && i > from && i <= to) return -width
  if (to < from && i >= to && i < from) return width
  return 0
}
