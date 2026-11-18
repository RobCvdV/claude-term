import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardKind,
  BoardLane,
  BoardView,
  TabInfo,
  TabStatus,
  WorkBoardState,
  WorkItem
} from '../../../shared/types'
import { WINDOW_KIND } from '../../../shared/window-titles'
import {
  BOARD_KINDS,
  BOARD_LANES,
  laneOf,
  matchesFilter,
  sessionFor
} from '../../../shared/work-board'
import { useAppSettings } from '../use-app-settings'
import { useMissionTabs } from '../use-mission-tabs'
import { useNow } from '../use-now'
import { activityLabel, dotFor, reviewVerdict } from '../work-status'
import { ActionChip, CiChip, PrChip, TicketPill } from './mission-parts'

interface Card {
  item: WorkItem
  lane: BoardLane
  session: TabStatus | null
  tab: TabInfo | null
}

function ago(ms: number, now: number): string {
  const min = Math.floor((now - ms) / 60_000)
  if (min < 1) return 'just now'
  return min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago`
}

/** Where "▶ session" starts, for its tooltip. */
function startTitle(item: WorkItem): string {
  const [first] = item.starts
  if (!first.sure) return 'Start a Claude session — pick the folder (right-click: same)'
  const folder = first.root.split('/').pop()
  const on = first.branch ? ` on ${first.branch}` : item.ticket ? ' on the ticket branch' : ''
  return `Start a Claude session in ${folder}${on} (right-click: pick another folder)`
}

/** `owner/repo` → `repo`, for chips where the owner is noise. */
const repoName = (repo: string): string => repo.split('/').pop() ?? repo

/** The Work board window: my open tickets, PRs, reviews and issues per
 *  context (MendriX, Personal, …), in lanes by whose move it is. Cards with
 *  an open session show it, and clicking them goes to that tab. */
export function BoardWindow(): React.JSX.Element {
  const now = useNow()
  const settings = useAppSettings()
  const { tabs, statuses } = useMissionTabs()
  const [board, setBoard] = useState<WorkBoardState>({
    items: [],
    errors: [],
    sweptAt: null,
    sweeping: false
  })
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = WINDOW_KIND.board
    void window.claudeTerm.boardState().then(setBoard)
    window.claudeTerm.refreshBoard()
    return window.claudeTerm.onBoardUpdate(setBoard)
  }, [])

  // "/" jumps to the filter, Escape clears it; ⇧⌘E closes the board, ⌘E opens Mission control
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inFilter = document.activeElement === filterRef.current
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (e.shiftKey) window.claudeTerm.toggleBoard()
        else window.claudeTerm.toggleMission()
      } else if (e.key === '/' && !inFilter && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        filterRef.current?.focus()
      } else if (e.key === 'Escape' && inFilter) {
        setQuery('')
        filterRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const view = settings.board
  const setView = (patch: Partial<BoardView>): void =>
    void window.claudeTerm.setAppSettings({ board: { ...view, ...patch } })
  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  const cards = useMemo((): Card[] => {
    const sessions = tabs.map((t) => statuses[t.tabId]).filter((s): s is TabStatus => !!s)
    return board.items.map((item) => {
      const session = sessionFor(item, sessions)
      return {
        item,
        session,
        lane: laneOf(item, session),
        tab: session ? (tabs.find((t) => t.tabId === session.tabId) ?? null) : null
      }
    })
  }, [board.items, tabs, statuses])

  const kinds = cards.filter((c) => !view.hiddenKinds.includes(c.item.kind))
  const shown = kinds.filter((c) => view.showHandedOff || !c.item.handedOff)
  const inContext = shown.filter((c) => view.context === 'all' || c.item.context === view.context)
  const filtered = inContext.filter((c) => matchesFilter(c.item, query))
  const lanes = BOARD_LANES.filter((l) => !view.hiddenLanes.includes(l.id))
  const contexts = [{ id: 'all', name: 'All' }, ...settings.workContexts]

  return (
    <div className="mission-window">
      <div className="mission-panel board-panel">
        <div className="activity-head board-head">
          <span className="activity-title">Work board</span>
          <span className="activity-range board-range">
            {contexts.map((ctx) => {
              const mine = shown.filter((c) => ctx.id === 'all' || c.item.context === ctx.id)
              const urgent = mine.filter((c) => c.lane === 'needs-you').length
              return (
                <button
                  key={ctx.id}
                  className={`range-btn ${view.context === ctx.id ? 'active' : ''}`}
                  onClick={() => setView({ context: ctx.id })}
                >
                  {ctx.name} <span className="dim">{mine.length}</span>
                  {urgent > 0 && <span className="tone-red"> · {urgent}</span>}
                </button>
              )
            })}
          </span>
          <input
            ref={filterRef}
            className="board-filter"
            placeholder="Filter — key, title, repo, status  (/)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="range-btn board-refresh"
            title="Fetch Jira, Bitbucket and GitHub again"
            onClick={() => window.claudeTerm.refreshBoard()}
            disabled={board.sweeping}
          >
            {board.sweeping ? 'updating…' : board.sweptAt ? `↻ ${ago(board.sweptAt, now)}` : '↻'}
          </button>
        </div>
        <div className="board-toggles">
          <span className="activity-range board-range">
            {BOARD_LANES.map((l) => (
              <button
                key={l.id}
                className={`range-btn ${view.hiddenLanes.includes(l.id) ? '' : 'active'}`}
                title={view.hiddenLanes.includes(l.id) ? 'show this lane' : 'hide this lane'}
                onClick={() => setView({ hiddenLanes: toggle(view.hiddenLanes, l.id) })}
              >
                {l.label} {filtered.filter((c) => c.lane === l.id).length}
              </button>
            ))}
          </span>
          <span className="activity-range board-range">
            {BOARD_KINDS.map((k) => (
              <button
                key={k.id}
                className={`range-btn ${view.hiddenKinds.includes(k.id) ? '' : 'active'}`}
                onClick={() => setView({ hiddenKinds: toggle<BoardKind>(view.hiddenKinds, k.id) })}
              >
                {k.label}
              </button>
            ))}
            <button
              className={`range-btn ${view.showHandedOff ? 'active' : ''}`}
              title="My PRs whose ticket is now on someone else's name"
              onClick={() => setView({ showHandedOff: !view.showHandedOff })}
            >
              Handed off {kinds.filter((c) => c.item.handedOff).length}
            </button>
          </span>
        </div>
        {board.errors.length > 0 && (
          <div className="board-errors tone-orange">
            {board.errors.map((e) => (
              <div key={e}>⚠ {e}</div>
            ))}
          </div>
        )}
        <div
          className="board-lanes"
          style={{
            gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(220px, 1fr))`
          }}
        >
          {lanes.map((lane) => {
            const laneCards = filtered.filter((c) => c.lane === lane.id)
            return (
              <section key={lane.id} className="board-lane">
                <div className="board-lane-title">
                  {lane.label} <span className="dim">{laneCards.length}</span>
                </div>
                {laneCards.map((c) => (
                  <BoardCard key={c.item.id} card={c} now={now} />
                ))}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function BoardCard({ card, now }: { card: Card; now: number }): React.JSX.Element {
  const { item, session, tab } = card
  const head =
    item.ticket?.key ??
    (item.review
      ? `${repoName(item.review.repo)} #${item.review.number}`
      : item.prs[0]
        ? `${repoName(item.prs[0].repo)} #${item.prs[0].number}`
        : item.url.replace(/^https:\/\/github\.com\//, '').replace('/issues/', ' #'))
  return (
    <button
      className={`mission-card board-card ${card.lane === 'needs-you' ? 'mission-alert' : ''}`}
      title={session ? 'go to the session' : item.url}
      onClick={() =>
        session ? window.claudeTerm.activateGlobalTab(session.tabId) : window.open(item.url)
      }
    >
      {session && (
        <div className="mission-row">
          <span className={dotFor(session)} />
          <span className="mission-title">{tab?.title ?? ''}</span>
          <span className="mission-activity">{activityLabel(session, now)}</span>
        </div>
      )}
      <div className="mission-row mission-branch-row">
        <span className="mission-branch">{head}</span>
        {item.ticket && <TicketPill ticket={item.ticket} />}
        {item.kind === 'issue' && <span className="mission-chip tone-dim">issue</span>}
        {item.handedOff && (
          <span className="mission-chip tone-dim" title="the ticket is on someone else's name">
            → {item.handedOff}
          </span>
        )}
      </div>
      <div className="mission-topic">{item.title}</div>
      {(item.prs.length > 0 || item.review || (!session && item.starts.length > 0)) && (
        <div className="mission-row mission-chips">
          {item.prs.map((pr) => (
            <span key={pr.url} className="board-pr">
              <PrChip pr={pr} label={item.ticket ? repoName(pr.repo) : 'PR'} />
              {pr.ci && <CiChip ci={pr.ci} name={pr.ci.name} />}
            </span>
          ))}
          {item.review && (
            <span className={`mission-chip ${reviewVerdict(item.review).tone}`}>
              {reviewVerdict(item.review).label}
              {item.review.author && <span className="dim"> · {item.review.author}</span>}
            </span>
          )}
          {!session && item.starts.length > 0 && (
            <ActionChip
              label="▶ session"
              done="✓ started"
              title={startTitle(item)}
              run={() => window.claudeTerm.startFromCard(item.id, false)}
              alt={() => window.claudeTerm.startFromCard(item.id, true)}
            />
          )}
        </div>
      )}
    </button>
  )
}
