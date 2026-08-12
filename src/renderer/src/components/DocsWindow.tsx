import { useEffect, useState } from 'react'
import type { DocGroup, DocTarget } from '../../../shared/types'
import { DocsView } from './DocsView'

const params = new URLSearchParams(location.search)
const TAB_ID = params.get('tabId') ?? ''
const INITIAL_GROUP = (params.get('group') as DocGroup) ?? 'docs'
const INITIAL_TITLE = params.get('title') ?? 'Docs'
const INITIAL_PATH = params.get('path')
const INITIAL_TARGET: DocTarget | null = INITIAL_PATH
  ? { path: INITIAL_PATH, edit: params.get('edit') === '1' }
  : null

/** Top-level component for the standalone docs window. Owns the section to
 *  show and the OS window title; both update when the owner tab re-opens. */
export function DocsWindow(): React.JSX.Element {
  const [group, setGroup] = useState<DocGroup>(INITIAL_GROUP)
  const [target, setTarget] = useState<DocTarget | null>(INITIAL_TARGET)

  useEffect(() => {
    document.title = INITIAL_TITLE
    return window.claudeTerm.onDocsSetGroup(({ group, title, target }) => {
      setGroup(group)
      setTarget(target ?? null)
      document.title = title
    })
  }, [])

  return <DocsView tabId={TAB_ID} group={group} target={target} />
}
