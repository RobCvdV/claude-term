import { useCallback, useEffect, useState } from 'react'
import type { DocGroup, DocTarget } from '../../../shared/types'
import { WINDOW_KIND, windowTitle } from '../../../shared/window-titles'
import { DocsView } from './DocsView'

const params = new URLSearchParams(location.search)
const TAB_ID = params.get('tabId') ?? ''
const INITIAL_GROUP = (params.get('group') as DocGroup) ?? 'docs'
const INITIAL_TITLE = params.get('title') ?? ''
const INITIAL_PATH = params.get('path')
const positive = (name: string): number | undefined => {
  const n = Number(params.get(name))
  return Number.isInteger(n) && n > 0 ? n : undefined
}
const INITIAL_TARGET: DocTarget | null = INITIAL_PATH
  ? {
      path: INITIAL_PATH,
      edit: params.get('edit') === '1',
      line: positive('line'),
      column: positive('column')
    }
  : null

/** Top-level component for the standalone file window. Owns which group to
 *  show and the OS window title; both update when the owner tab re-opens it. */
export function DocsWindow(): React.JSX.Element {
  const [group, setGroup] = useState<DocGroup>(INITIAL_GROUP)
  const [target, setTarget] = useState<DocTarget | null>(INITIAL_TARGET)
  // the tab this window belongs to (project + branch), from the main window
  const [owner, setOwner] = useState(INITIAL_TITLE)
  // the file on screen, so a switcher shows which one this window is on
  const [openFile, setOpenFile] = useState<string | null>(null)

  useEffect(() => {
    return window.claudeTerm.onDocsSetGroup(({ group, title, target }) => {
      setGroup(group)
      setTarget(target ?? null)
      setOwner(title)
    })
  }, [])

  useEffect(() => {
    document.title = windowTitle(WINDOW_KIND.files, openFile, owner)
  }, [openFile, owner])

  return (
    <DocsView
      tabId={TAB_ID}
      group={group}
      target={target}
      onOpenFile={useCallback((label: string | null) => setOpenFile(label), [])}
    />
  )
}
