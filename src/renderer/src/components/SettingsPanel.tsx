import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AppSettingsPatch,
  IntegrationStatus,
  NotifyEvent
} from '../../../shared/types'
import { useModalOverlay } from '../modal-overlay'
import { JiraConnectBar } from './ActivityOverview'
import { SpellToggle } from './SpellToggle'
import { VolumeControl } from './VolumeControl'

const EVENTS: { key: NotifyEvent; label: string; hint?: string }[] = [
  { key: 'prApproved', label: 'PR approved' },
  { key: 'prChanges', label: 'Changes requested on a PR' },
  { key: 'prComments', label: 'New PR comments', hint: 'your own replies count too' },
  { key: 'readyToMerge', label: 'PR ready to merge', hint: 'approved, green, nothing unpushed' },
  { key: 'reviewRequested', label: 'A PR asks for your review' },
  { key: 'ciFailed', label: 'Build failed' },
  { key: 'ciFixed', label: 'Build green again after a failure' },
  { key: 'ticketMoved', label: 'Jira ticket moved', hint: 'by someone else' },
  {
    key: 'needsInput',
    label: 'Session needs input',
    hint: 'only while the app is in the background'
  }
]

function Toggle({
  on,
  onChange,
  label,
  hint,
  disabled
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className={`settings-row ${disabled ? 'settings-off' : ''}`}>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
      {hint && <span className="settings-hint">{hint}</span>}
    </label>
  )
}

function Service({
  name,
  ok,
  detail,
  howTo
}: {
  name: string
  ok: boolean
  detail?: string
  howTo: string
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <span className={ok ? 'tone-green' : 'tone-dim'}>●</span>
      <span>{name}</span>
      <span className="settings-hint">{ok ? (detail ?? 'connected') : howTo}</span>
    </div>
  )
}

/** ⌘, — the app's switches in one place. Changes apply at once; tokens other
 *  than Jira's come from the login shell, so those rows only report. */
export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const panelRef = useModalOverlay<HTMLDivElement>(onClose)
  const [s, setS] = useState<AppSettings | null>(null)
  const [svc, setSvc] = useState<IntegrationStatus | null>(null)
  const [testSent, setTestSent] = useState(false)

  useEffect(() => {
    void window.claudeTerm.appSettings().then(setS)
    void window.claudeTerm.integrations().then(setSvc)
    return window.claudeTerm.onAppSettings(setS)
  }, [])

  const set = (patch: AppSettingsPatch): void => {
    void window.claudeTerm.setAppSettings(patch).then(setS)
  }
  const notifyOff = !s?.notify.enabled

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="activity-panel settings-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-head">
          <span className="activity-title">Settings</span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        {s && (
          <div className="settings-body">
            <section>
              <h3>Notifications</h3>
              <Toggle
                on={s.notify.enabled}
                onChange={(enabled) => set({ notify: { enabled } })}
                label="Show notifications"
              />
              <Toggle
                on={s.notify.onlyWhenUnfocused}
                onChange={(onlyWhenUnfocused) => set({ notify: { onlyWhenUnfocused } })}
                label="Only while the app is in the background"
                disabled={notifyOff}
              />
              <Toggle
                on={s.notify.sound}
                onChange={(sound) => set({ notify: { sound } })}
                label="Play a sound"
                disabled={notifyOff}
              />
              <div className="settings-sub">
                {EVENTS.map((ev) => (
                  <Toggle
                    key={ev.key}
                    on={s.notify[ev.key]}
                    onChange={(on) => set({ notify: { [ev.key]: on } })}
                    label={ev.label}
                    hint={ev.hint}
                    disabled={notifyOff}
                  />
                ))}
              </div>
              <button
                className="settings-button"
                disabled={notifyOff}
                onClick={() => {
                  window.claudeTerm.testNotification()
                  setTestSent(true)
                }}
              >
                {testSent ? 'Sent — check the corner of your screen' : 'Send a test notification'}
              </button>
            </section>

            <section>
              <h3>Status &amp; Mission control</h3>
              <Toggle
                on={s.ciPolling}
                onChange={(ciPolling) => set({ ciPolling })}
                label="Poll CI for build state"
                hint="Jenkins, CircleCI, GitHub Actions"
              />
              <Toggle
                on={s.jiraTicketStatus}
                onChange={(jiraTicketStatus) => set({ jiraTicketStatus })}
                label="Show the branch ticket's Jira status"
                hint="reads the Jira token from the keychain — may ask for your password"
              />
              <Toggle
                on={s.reviewQueue}
                onChange={(reviewQueue) => set({ reviewQueue })}
                label="Show PRs waiting on my review"
                hint="Mission control, every 5 minutes"
              />
              <label className="settings-row">
                <span>Flag a PR&apos;d branch from</span>
                <input
                  type="number"
                  className="settings-number"
                  min={1}
                  max={500}
                  value={s.behindThreshold}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value))
                    if (n >= 1) set({ behindThreshold: n })
                  }}
                />
                <span>commits behind main</span>
                <span className="settings-hint">as of the last fetch</span>
              </label>
            </section>

            <section>
              <h3>Windows &amp; tabs</h3>
              <Toggle
                on={s.tabKeysPerWindow}
                onChange={(tabKeysPerWindow) => set({ tabKeysPerWindow })}
                label="Tab shortcuts stay in their window"
                hint="⌘1–9, ⌘[ ⌘]"
              />
              <Toggle
                on={s.restoreWindowBounds}
                onChange={(restoreWindowBounds) => set({ restoreWindowBounds })}
                label="Restore window positions"
              />
              <Toggle
                on={s.keepAwake}
                onChange={(keepAwake) => set({ keepAwake })}
                label="Keep the Mac awake while a session works"
                hint="and 10 minutes after"
              />
              <div className="settings-row">
                <span>Spell check</span>
                <SpellToggle />
              </div>
              <div className="settings-row">
                <span>Notification volume</span>
                <VolumeControl />
              </div>
            </section>

            <section>
              <h3>Integrations</h3>
              {svc && (
                <>
                  <Service
                    name="Jira"
                    ok={svc.jira.connected}
                    detail={svc.jira.connected ? svc.jira.email : undefined}
                    howTo="connect below"
                  />
                  {svc.jira.connected ? (
                    <button
                      className="settings-button"
                      onClick={() =>
                        void window.claudeTerm
                          .jiraDisconnect()
                          .then(() => setSvc({ ...svc, jira: { connected: false } }))
                      }
                    >
                      Disconnect Jira
                    </button>
                  ) : (
                    <JiraConnectBar onConnected={(jira) => setSvc({ ...svc, jira })} />
                  )}
                  <Service
                    name="Bitbucket"
                    ok={svc.bitbucket}
                    howTo="export BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in ~/.zshrc"
                  />
                  <Service
                    name="GitHub"
                    ok={!!svc.github}
                    detail={svc.github ?? undefined}
                    howTo="run gh auth login"
                  />
                  <Service
                    name="CircleCI"
                    ok={svc.circleci}
                    howTo="export CIRCLECI_TOKEN (User Settings → Personal API Tokens)"
                  />
                  <Service
                    name="Jenkins"
                    ok={svc.jenkins}
                    detail="token set"
                    howTo="optional: export JENKINS_USER and JENKINS_API_TOKEN"
                  />
                  <div className="settings-hint settings-note">
                    Shell tokens are read when the app starts — restart it after changing one.
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
