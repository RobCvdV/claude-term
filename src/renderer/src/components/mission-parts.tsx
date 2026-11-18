import { useState } from 'react'
import type { BranchPr, CiState, TicketStatus } from '../../../shared/types'
import { ticketUrl } from '../../../shared/jira-labels'
import { ciLabel, ciTone, prReviewLabel, prTone, ticketTone } from '../work-status'

// Card parts shared by Mission control and the Work board.

export function LinkChip({
  url,
  className,
  title,
  children
}: {
  url: string
  className: string
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role="link"
      className={`mission-chip ${className}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        window.open(url)
      }}
    >
      {children}
    </span>
  )
}

/** A small action inside a card: runs without selecting the card. */
export function ActionChip({
  label,
  title,
  run
}: {
  label: string
  title: string
  run: () => Promise<{ ok: boolean; error?: string }>
}): React.JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  return (
    <span
      role="button"
      className={`mission-action ${phase === 'done' ? 'tone-green' : phase === 'failed' ? 'tone-red' : ''}`}
      title={error ?? title}
      onClick={(e) => {
        e.stopPropagation()
        if (phase === 'busy' || phase === 'done') return
        setPhase('busy')
        void run().then((r) => {
          // ok=false without an error is a cancelled confirmation
          setPhase(r.ok ? 'done' : r.error ? 'failed' : 'idle')
          setError(r.error ?? null)
        })
      }}
    >
      {phase === 'busy'
        ? '…'
        : phase === 'done'
          ? '✓ moved'
          : phase === 'failed'
            ? `${label} failed`
            : label}
    </span>
  )
}

/** The ticket's board status, linking to the ticket. */
export function TicketPill({ ticket }: { ticket: TicketStatus }): React.JSX.Element {
  return (
    <LinkChip
      url={ticketUrl(ticket.key)}
      className={`mission-pill ${ticketTone(ticket)}`}
      title={`${ticket.key}: ${ticket.summary}${ticket.assignee ? ` — ${ticket.assignee}` : ''}`}
    >
      {ticket.status}
    </LinkChip>
  )
}

/** A PR's review state and comment count, linking to the PR. */
export function PrChip({ pr, label }: { pr: BranchPr; label?: string }): React.JSX.Element {
  return (
    <LinkChip url={pr.url} className={prTone(pr)} title={pr.title}>
      ● {label ?? 'PR'} #{pr.number} {prReviewLabel(pr)}
      {pr.comments ? <span className="dim"> · {pr.comments} 💬</span> : null}
    </LinkChip>
  )
}

/** A build's state (with progress while running), linking to the build. */
export function CiChip({
  ci,
  name,
  title
}: {
  ci: { state: CiState; url: string; progress?: number }
  name: string
  title?: string
}): React.JSX.Element {
  return (
    <LinkChip url={ci.url} className={ciTone(ci)} title={title ?? name}>
      <span className={ci.state === 'running' ? 'ci-running' : undefined}>●</span> {name}{' '}
      {ciLabel(ci)}
      {ci.state === 'running' && ci.progress != null && (
        <span className="mission-bar">
          <span style={{ width: `${ci.progress}%` }} />
        </span>
      )}
    </LinkChip>
  )
}
