import type { DocGroup, DocTarget, TabId } from '../shared/types'
import { WINDOW_KIND, windowTitle } from '../shared/window-titles'
import { createFileWindows } from './file-window'

/** What the docs window is showing: a section, optionally one specific file. */
interface DocsOpen {
  group: DocGroup
  target?: DocTarget
}

const windows = createFileWindows<DocsOpen>({
  channel: 'docs',
  width: 900,
  height: 720,
  subject: 'document',
  // until the renderer loads and names the file it landed on
  osTitle: (title) => windowTitle(WINDOW_KIND.files, title),
  query: (tabId, title, { group, target }) =>
    `?docs=1&tabId=${encodeURIComponent(tabId)}` +
    `&group=${group}&title=${encodeURIComponent(title)}` +
    (target ? `&path=${encodeURIComponent(target.path)}${target.edit ? '&edit=1' : ''}` : ''),
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
