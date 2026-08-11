import { useEffect, useRef } from 'react'

/**
 * Modal-overlay behavior: grab keyboard focus into the panel on mount (so
 * keystrokes stop reaching the terminal underneath) and close on Escape in
 * the CAPTURE phase. Bubble-phase listeners never fire with focus in the
 * terminal or prompt box — xterm and Monaco consume the key — and an Esc that
 * reaches the terminal is forwarded to the PTY, where it can interrupt a
 * running turn or cancel a permission dialog.
 *
 * Attach the returned ref to the panel element along with `tabIndex={-1}`.
 */
export function useModalOverlay<T extends HTMLElement>(
  onClose: () => void
): React.RefObject<T | null> {
  const panelRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    const panel = panelRef.current
    panel?.focus()
    // a just-closed opener (the ⌘K palette) restores focus to the tab via
    // rAF, which would undo the grab — re-assert one frame after that
    let alive = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (alive && panel && !panel.contains(document.activeElement)) panel.focus()
      })
    )
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  return panelRef
}
