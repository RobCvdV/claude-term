import { useEffect, useRef, useState } from 'react'
import type { TabId } from '../../../shared/types'
import { focusTerm, getTerm } from '../term-registry'

interface Props {
  tabId: TabId
  /** bar is visible; stays mounted while hidden so the query survives */
  open: boolean
  /** bumped on every ⌘F — refocuses/selects the input even when already open */
  focusNonce: number
  onClose: () => void
}

const DECORATIONS = {
  matchBackground: '#3b4c6b',
  matchOverviewRuler: '#3b4c6b',
  activeMatchBackground: '#b07d1e',
  activeMatchColorOverviewRuler: '#b07d1e'
}

/** Slim find bar over the terminal (⌘F): Enter = next, ⇧Enter = previous. */
export function TermSearchBar({ tabId, open, focusNonce, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  // A full-screen program (Claude Code, less, vim) draws on the terminal's
  // alternate buffer, which has no scrollback — only what is on screen exists.
  // The bar is mounted per tab, so its first value can be read straight off the
  // terminal and kept up to date from there.
  const [screenOnly, setScreenOnly] = useState(
    () => getTerm(tabId)?.term.buffer.active.type === 'alternate'
  )
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const term = getTerm(tabId)?.term
    if (!term) return
    const sub = term.buffer.onBufferChange((buffer) => setScreenOnly(buffer.type === 'alternate'))
    return () => sub.dispose()
  }, [tabId])

  // match counter (only reported while decorations are active)
  useEffect(() => {
    const search = getTerm(tabId)?.search
    if (!search) return
    const sub = search.onDidChangeResults((e) =>
      setResult(e.resultCount > 0 ? { index: e.resultIndex, count: e.resultCount } : null)
    )
    return () => sub.dispose()
  }, [tabId])

  const find = (q: string, dir: 'next' | 'prev', incremental = false): void => {
    const search = getTerm(tabId)?.search
    if (!search || !q) return
    const opts = { incremental, decorations: DECORATIONS }
    if (dir === 'next') search.findNext(q, opts)
    else search.findPrevious(q, opts)
  }

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    // Re-run the query the bar remembers. Closing cleared its highlights and
    // its count, so without this ⌘F comes back showing "0/0" over a query that
    // does match — which reads as a broken search. Incremental keeps the
    // current match rather than stepping past it.
    if (query) find(query, 'next', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusNonce])

  const close = (): void => {
    getTerm(tabId)?.search.clearDecorations()
    setResult(null)
    onClose()
    focusTerm(tabId)
  }

  return (
    <div className="term-search" style={{ display: open ? 'flex' : 'none' }}>
      <input
        ref={inputRef}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          if (e.target.value) find(e.target.value, 'next', true)
          else {
            getTerm(tabId)?.search.clearDecorations()
            setResult(null)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(query, e.shiftKey ? 'prev' : 'next')
          else if (e.key === 'Escape') close()
        }}
      />
      <span className="term-search-count">
        {query ? (result ? `${result.index + 1}/${result.count}` : '0/0') : ''}
      </span>
      {screenOnly && (
        <span
          className="term-search-note"
          title="A full-screen program is drawing over the terminal (Claude Code, less, vim). It keeps its own history, so only what is on screen right now can be searched."
        >
          screen only
        </span>
      )}
      <button title="Previous match (⇧Enter)" onClick={() => find(query, 'prev')}>
        ↑
      </button>
      <button title="Next match (Enter)" onClick={() => find(query, 'next')}>
        ↓
      </button>
      <button title="Close (Esc)" onClick={close}>
        ×
      </button>
    </div>
  )
}
