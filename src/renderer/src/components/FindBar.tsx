import { useEffect, useRef, useState } from 'react'
import type { ConvoHit, ConvoSearchResult, FindScope, TabId } from '../../../shared/types'
import { agoLabel } from '../branch-recall'
import { previewOf, roleLabel, segments, stepHit, type Preview } from '../convo-find'
import { focusTerm, getTerm } from '../term-registry'

interface Props {
  tabId: TabId
  /** a Claude session runs in this tab, so its conversation can be searched */
  canSearchConvo: boolean
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

/** Reading a transcript costs a file read in main, so wait for a pause in the
 *  typing — screen search stays incremental, it is free. */
const DEBOUNCE_MS = 180

/** A search result together with the question it answers. */
interface Answer {
  query: string
  includeTools: boolean
  result: ConvoSearchResult
}

/**
 * ⌘F over the terminal. With a live Claude session it searches the
 * conversation — the session's transcript — because the TUI draws on the
 * alternate screen buffer, which keeps no scrollback: everything scrolled past
 * is gone from the terminal but still in the transcript. The `screen` scope is
 * the plain xterm search, for whatever is on screen (or in a plain shell's
 * scrollback). Enter = next, ⇧Enter = previous.
 */
export function FindBar({
  tabId,
  canSearchConvo,
  open,
  focusNonce,
  onClose
}: Props): React.JSX.Element {
  // the scope the user asked for, or none yet — a tab without a session can
  // only search its screen, so what ⌘F does follows the session
  const [picked, setPicked] = useState<FindScope | null>(null)
  const scope: FindScope = canSearchConvo ? (picked ?? 'conversation') : 'screen'
  const [query, setQuery] = useState('')
  const [includeTools, setIncludeTools] = useState(false)
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  // tagged with what it answers, so a result is never shown for another query
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [selected, setSelected] = useState(-1)
  // A full-screen program (Claude Code, less, vim) draws on the terminal's
  // alternate buffer, which has no scrollback — only what is on screen exists.
  // The bar is mounted per tab, so its first value can be read straight off the
  // terminal and kept up to date from there.
  const [screenOnly, setScreenOnly] = useState(
    () => getTerm(tabId)?.term.buffer.active.type === 'alternate'
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

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
    if (query && scope === 'screen') find(query, 'next', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusNonce])

  // Search the conversation. Re-runs when the bar re-opens too: a live session
  // has said more since last time.
  useEffect(() => {
    if (scope !== 'conversation' || !open || !query.trim()) return
    let alive = true
    const timer = setTimeout(() => {
      void window.claudeTerm.searchConversation(tabId, query, includeTools).then((result) => {
        if (!alive) return
        setAnswer({ query, includeTools, result })
        setSelected(result.hits.length ? 0 : -1)
      })
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [scope, open, query, includeTools, tabId, focusNonce])

  // the terminal keeps its highlights until the conversation takes over
  useEffect(() => {
    if (scope === 'conversation') getTerm(tabId)?.search.clearDecorations()
  }, [scope, tabId])

  useEffect(() => {
    listRef.current?.querySelector('.find-hit.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected, answer])

  // an answer to an older query is stale the moment the query moves on
  const convo =
    scope === 'conversation' &&
    answer &&
    answer.query === query &&
    answer.includeTools === includeTools
      ? answer.result
      : null

  const step = (dir: 1 | -1): void => {
    if (scope === 'screen') find(query, dir === 1 ? 'next' : 'prev')
    else setSelected((current) => stepHit(convo?.hits.length ?? 0, current, dir))
  }

  const pickScope = (next: FindScope): void => {
    setPicked(next)
    if (next === 'screen' && query) find(query, 'next', true)
    inputRef.current?.focus()
  }

  const close = (): void => {
    getTerm(tabId)?.search.clearDecorations()
    setResult(null)
    onClose()
    focusTerm(tabId)
  }

  const hits = convo?.hits ?? []
  const counter =
    scope === 'conversation'
      ? !query.trim()
        ? ''
        : convo
          ? `${selected + 1}/${convo.total}`
          : '…'
      : query
        ? result
          ? `${result.index + 1}/${result.count}`
          : '0/0'
        : ''

  return (
    <div className="find-bar" style={{ display: open ? 'flex' : 'none' }}>
      <div className="term-search">
        <input
          ref={inputRef}
          value={query}
          placeholder={scope === 'conversation' ? 'Find in conversation' : 'Find on screen'}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            if (scope !== 'screen') return
            if (e.target.value) find(e.target.value, 'next', true)
            else {
              getTerm(tabId)?.search.clearDecorations()
              setResult(null)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
            else if (e.key === 'ArrowDown') step(1)
            else if (e.key === 'ArrowUp') step(-1)
            else if (e.key === 'Escape') close()
            else return
            e.preventDefault()
          }}
        />
        <span
          className="term-search-count"
          title={
            convo && convo.total > hits.length
              ? `the newest ${hits.length} of ${convo.total} matching turns`
              : undefined
          }
        >
          {counter}
        </span>
        {canSearchConvo && (
          <span className="find-scope">
            <button
              className={scope === 'conversation' ? 'on' : undefined}
              title="Search this session's conversation, all the way back to its first turn"
              onClick={() => pickScope('conversation')}
            >
              conversation
            </button>
            <button
              className={scope === 'screen' ? 'on' : undefined}
              title="Search the terminal itself — what the session has on screen right now"
              onClick={() => pickScope('screen')}
            >
              screen
            </button>
          </span>
        )}
        {scope === 'conversation' && (
          <button
            className={includeTools ? 'find-toggle on' : 'find-toggle'}
            title="Also search tool calls, their output and Claude's thinking"
            onClick={() => {
              setIncludeTools((on) => !on)
              inputRef.current?.focus()
            }}
          >
            + tools
          </button>
        )}
        {scope === 'screen' && screenOnly && (
          <span
            className="term-search-note"
            title="A full-screen program is drawing over the terminal (Claude Code, less, vim). It keeps its own history, so only what is on screen right now can be searched."
          >
            screen only
          </span>
        )}
        <button title="Previous match (⇧Enter)" onClick={() => step(-1)}>
          ↑
        </button>
        <button title="Next match (Enter)" onClick={() => step(1)}>
          ↓
        </button>
        <button title="Close (Esc)" onClick={close}>
          ×
        </button>
      </div>
      {scope === 'conversation' && Boolean(query.trim()) && (
        <div className="find-results" ref={listRef}>
          {hits.length === 0 && (
            <div className="find-empty">{convo ? emptyNote(convo) : 'searching…'}</div>
          )}
          {hits.map((hit, i) => (
            <Hit
              key={hit.index}
              hit={hit}
              selected={i === selected}
              onPick={() => {
                setSelected(i)
                inputRef.current?.focus()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function emptyNote(convo: ConvoSearchResult): string {
  if (!convo.found) return 'no transcript for this session yet'
  if (!convo.searched) return 'nothing said in this session yet'
  return 'no match in this conversation'
}

/** One matching turn: who said it and when, its match in context, and — while
 *  it is the selected one — the whole turn to read. */
function Hit({
  hit,
  selected,
  onPick
}: {
  hit: ConvoHit
  selected: boolean
  onPick: () => void
}): React.JSX.Element {
  const shown: Preview = selected ? { text: hit.text, matches: hit.matches } : previewOf(hit)
  return (
    <div
      className={selected ? 'find-hit selected' : 'find-hit'}
      // clicking must not pull focus out of the query input
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <div className="find-hit-head">
        <span className={`find-role find-role-${hit.role}`}>{roleLabel(hit)}</span>
        {hit.time && <span className="find-time">{agoLabel(Date.parse(hit.time))}</span>}
        {selected && (
          <button
            className="find-copy"
            title="Copy this turn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(hit.text)
            }}
          >
            copy
          </button>
        )}
      </div>
      <div className={selected ? 'find-hit-text full' : 'find-hit-text'}>
        {segments(shown.text, shown.matches).map((seg, i) =>
          seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
        )}
      </div>
    </div>
  )
}
