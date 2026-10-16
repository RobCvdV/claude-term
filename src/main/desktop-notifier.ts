import { Notification } from 'electron'
import type { NotifyEvent, TabId } from '../shared/types'
import { appSettings } from './app-settings'

export interface Notice {
  kind: NotifyEvent
  alsoKind?: NotifyEvent
  /** same key + title within the quiet window is shown once */
  key: string
  title: string
  body: string
  tabId?: TabId
  url?: string
}

const QUIET_MS = 5 * 60_000

/** macOS notifications for the switches in Settings → Notifications. */
export class DesktopNotifier {
  private shownAt = new Map<string, number>()
  // a garbage-collected Notification loses its click handler
  private live = new Set<Notification>()

  constructor(
    private readonly anyFocused: () => boolean,
    private readonly revealTab: (tabId: TabId) => void,
    private readonly openUrl: (url: string) => void
  ) {}

  notify(n: Notice): void {
    const { notify } = appSettings()
    if (!notify.enabled || !(notify[n.kind] || (n.alsoKind && notify[n.alsoKind]))) return
    if (notify.onlyWhenUnfocused && this.anyFocused()) return
    const dedupe = `${n.key}|${n.title}`
    const last = this.shownAt.get(dedupe)
    if (last && Date.now() - last < QUIET_MS) return
    this.shownAt.set(dedupe, Date.now())
    this.show(n.title, n.body, notify.sound, () => {
      if (n.tabId) this.revealTab(n.tabId)
      else if (n.url) this.openUrl(n.url)
    })
  }

  /** Settings' test button: ignores the switches, shows what one looks like. */
  test(): void {
    this.show('claude-term', 'Notifications are working.', appSettings().notify.sound)
  }

  private show(title: string, body: string, sound: boolean, onClick?: () => void): void {
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, silent: !sound })
    this.live.add(note)
    note.on('click', () => onClick?.())
    note.on('close', () => this.live.delete(note))
    note.show()
    // macOS keeps a shown notification in Notification Center; drop our handle eventually
    setTimeout(() => this.live.delete(note), 60 * 60_000)
  }
}
