import { useEffect, useState } from 'react'
import type { HelpSection } from '../../../shared/types'

interface Props {
  section: HelpSection
  onClose: () => void
}

function Keys({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="help-row">
      <span className="help-keys">
        {k.split(' ').map((part) => (
          <kbd key={part}>{part}</kbd>
        ))}
      </span>
      <span className="help-desc">{children}</span>
    </div>
  )
}

function HowTo(): React.JSX.Element {
  return (
    <div className="help-columns">
      <section>
        <h3>Tabs</h3>
        <Keys k="⌘T">New tab (home folder)</Keys>
        <Keys k="⌘O">New tab in a chosen folder</Keys>
        <Keys k="⌘W">Close tab</Keys>
        <Keys k="⌘1 …9">Jump to tab 1–9</Keys>
        <Keys k="⌘[ ⌘]">Previous / next tab</Keys>
        <Keys k="right-click">Rename a tab (on its title)</Keys>
        <Keys k="drag">Reorder tabs</Keys>
        <div className="help-note">
          A tab starts as a plain shell — run <code>claude</code> in it and the prompt box + status
          bar appear automatically.
        </div>
      </section>
      <section>
        <h3>Getting around</h3>
        <Keys k="⌘K">Command palette — fuzzy-jump to a tab or run an action</Keys>
        <Keys k="⌘E">Mission control — every tab at a glance</Keys>
        <Keys k="⌘⇧A">Jump to the next tab waiting for input</Keys>
        <Keys k="⌘F">Search the terminal scrollback</Keys>
        <Keys k="⌘L">Focus the prompt box</Keys>
        <Keys k="Esc">
          Prompt box → terminal; terminal → prompt box (when nothing needs answering)
        </Keys>
        <div className="help-note">
          A red <b>“N waiting”</b> pill appears in the tab bar when sessions are blocked on a
          permission prompt — click it to jump there.
        </div>
      </section>
      <section>
        <h3>Prompt box</h3>
        <Keys k="Enter">Send — ⇧Enter for a newline</Keys>
        <Keys k="/">Slash commands (Claude&apos;s + app commands like /color, /switch)</Keys>
        <Keys k="@">File mentions with fuzzy completion</Keys>
        <Keys k="↑ ↓">Prompt history</Keys>
        <Keys k="Tab">Run Claude&apos;s grayed-out suggestion</Keys>
        <Keys k="⇧Tab">Cycle the permission mode</Keys>
        <Keys k="←">Agents overview (on an empty box)</Keys>
        <div className="help-note">
          Drop files anywhere: they become @-mentions; images attach as compact chips.
        </div>
      </section>
      <section>
        <h3>Status bar</h3>
        <Keys k="click">
          Folder chip opens Finder — (+N) lists the session&apos;s other folders
        </Keys>
        <Keys k="right-click">
          Folder chip: open in WebStorm / VS Code / Finder / iTerm2 / new tab
        </Keys>
        <Keys k="PRs">
          Open PRs of every workspace repo, grouped by folder — click opens, right-click: Open /
          Merge
        </Keys>
        <Keys k="links">Branch → repo · ticket → Jira · CI / Actions / Releases</Keys>
        <Keys k="● CI">Dot on a CI link = live build state (green / red / pulsing)</Keys>
        <Keys k="🕐">Activity hours (tab bar, top right) — engaged time per ticket</Keys>
      </section>
    </div>
  )
}

function Guide(): React.JSX.Element {
  return (
    <div className="help-guide">
      <section>
        <h3>Sessions that survive</h3>
        <p>
          Closing the app never loses a conversation. Tabs, their colors, titles, prompt drafts and
          history are persisted; on the next launch every tab is recreated and its Claude session
          resumed — even sessions that kept running as background agents are re-attached rather than
          restarted. A session revives in its own home folder, so conversations never get dragged
          into the wrong project.
        </p>
      </section>
      <section>
        <h3>The prompt box</h3>
        <p>
          The box under the terminal is a full editor: multiline input, spell + grammar checking,
          and completion popups for <code>/</code> commands (Claude&apos;s own, your plugins, and
          app-local ones) and <code>@</code> file mentions fed by the project&apos;s git files. App
          commands run inside the app — <code>/color orange</code> tints the tab,{' '}
          <code>/switch</code> completes local branches and renames the session to match,{' '}
          <code>/npm</code> lists the project&apos;s npm scripts (root + one folder deep) — Enter
          runs one, Tab fills <code>!npm run …</code> to add params — and <code>/add-dir</code>{' '}
          completes directories. When Claude shows a grayed-out suggested next prompt in the
          terminal, <b>Tab</b> in the empty box runs it.
        </p>
      </section>
      <section>
        <h3>Focus follows the conversation</h3>
        <p>
          You rarely need to click: when a permission prompt or picker opens, the terminal takes
          focus so arrows + Enter work immediately; when the turn finishes, focus returns to the
          prompt box. Esc hops between the two manually. When several sessions run in parallel, the{' '}
          <b>“N waiting”</b> pill and <b>⌘⇧A</b> queue you through everything that&apos;s blocked.
        </p>
      </section>
      <section>
        <h3>Mission control</h3>
        <p>
          <b>⌘E</b> shows every tab at a glance: activity and elapsed time, folder and branch,
          context usage, live CI state and a one-line summary of what each session is doing (long
          turns are compressed by the local Bonsai model when one is running — plain truncation
          otherwise). Click a card to jump there.
        </p>
      </section>
      <section>
        <h3>Status bar anatomy</h3>
        <p>
          Left to right: activity dot (busy timer, needs-input, idle), the tab&apos;s folder plus
          every other folder the session works in, git branch (ticket linked to Jira, branch to the
          repo) with changed/ahead/behind counts, the model and its reasoning effort, context usage
          (orange from 60%, red from 78%), and the 5-hour / 7-day rate-limit windows with
          time-to-reset — hover them for a burn forecast, and they turn orange early when the
          current pace hits 100% before the reset. On the right: plan / roadmap / docs / settings
          editor windows for the project, CI links (Jenkins for TMS repos, CircleCI, GitHub Actions)
          with a live build-state dot, the open-PRs dropdown, Releases, notification volume, and the
          clock.
        </p>
      </section>
      <section>
        <h3>Activity hours → Jira</h3>
        <p>
          A global hook logs engaged time per ticket while you work (idle gaps capped). The 🕐 view
          aggregates it per day and per MTX ticket; connect a Jira API token once and book the
          suggested worklogs straight from the panel — already-booked entries show a ✓.
        </p>
      </section>
      <section>
        <h3>Docs, plans &amp; settings</h3>
        <p>
          The status bar surfaces the project&apos;s markdown: plan-mode plans written by Claude, a{' '}
          <code>ROADMAP.md</code>, and other docs — each opens in a separate editor window with
          spell/grammar checking. <b>settings</b> lists every Claude/config file that applies to the
          project (global, project and local settings, CLAUDE.md, MCP config …).
        </p>
      </section>
      <section>
        <h3>Updates</h3>
        <p>
          Updates download in the background (checked on launch and daily). An <b>⬆ Update</b> pill
          appears in the tab bar when one is ready — click to restart and install; the
          session-restore brings all tabs and conversations back. “Check for Updates…” lives in the
          app menu.
        </p>
      </section>
    </div>
  )
}

/** Help overlay (Help menu / ⌘/): Quick How-To cheat sheet + User Guide.
 *  App keys the element by `section`, so a menu pick re-mounts on the right tab. */
export function HelpOverlay({ section, onClose }: Props): React.JSX.Element {
  const [active, setActive] = useState<HelpSection>(section)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div className="activity-panel help-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <span className="activity-title">Help</span>
          <div className="activity-range">
            <button
              className={`range-btn ${active === 'howto' ? 'active' : ''}`}
              onClick={() => setActive('howto')}
            >
              Quick How-To
            </button>
            <button
              className={`range-btn ${active === 'guide' ? 'active' : ''}`}
              onClick={() => setActive('guide')}
            >
              User Guide
            </button>
          </div>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        <div className="help-body">{active === 'howto' ? <HowTo /> : <Guide />}</div>
      </div>
    </div>
  )
}
