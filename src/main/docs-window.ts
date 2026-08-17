import type { DocGroup, DocTarget, TabId } from '../shared/types'
import { WINDOW_KIND, windowTitle } from '../shared/window-titles'
import { createFileWindows } from './file-window'

/** What the docs window is showing: a section, optionally one specific file. */
interface DocsOpen {
  group: DocGroup
  target?: DocTarget
}

/**
 * The window's own URL. Every part of the target has to survive it: a window
 * that has to be *created* is handed its target this way and never receives the
 * retarget message, so anything left out here is silently lost on first open.
 */
export function docsQuery(tabId: TabId, title: string, { group, target }: DocsOpen): string {
  const params = new URLSearchParams({ docs: '1', tabId, group, title })
  if (target) {
    params.set('path', target.path)
    if (target.edit) params.set('edit', '1')
    if (target.line) params.set('line', String(target.line))
    if (target.column) params.set('column', String(target.column))
  }
  return `?${params.toString()}`
}

const windows = createFileWindows<DocsOpen>({
  channel: 'docs',
  width: 900,
  height: 720,
  subject: 'document',
  // until the renderer loads and names the file it landed on
  osTitle: (title) => windowTitle(WINDOW_KIND.files, title),
  query: docsQuery,
  // the renderer owns the OS title here — it sets document.title from this
  retarget: (win, title, { group, target }) =>
    win.webContents.send('docs:setGroup', { group, title, target })
})

/** Open the docs window for a tab, or focus + retarget it if already open.
 *  `target` opens one specific file (e.g. the doc `/add-file` just created)
 *  instead of the group's first entry. */
export function openOrFocusDocsWindow(
  tabId: TabId,
  group: DocGroup,
  title: string,
  target?: DocTarget
): void {
  windows.openOrFocus(tabId, title, { group, target })
}

export const closeDocsWindowForTab = windows.closeForTab
export const closeAllDocsWindows = windows.closeAll
