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
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusNonce])

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
