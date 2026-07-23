import { useEffect, useState } from 'react'
import type { DocGroup } from '../../../shared/types'
import { DocsView } from './DocsView'

const params = new URLSearchParams(location.search)
const TAB_ID = params.get('tabId') ?? ''
const INITIAL_GROUP = (params.get('group') as DocGroup) ?? 'docs'
const INITIAL_TITLE = params.get('title') ?? 'Docs'

/** Top-level component for the standalone docs window. Owns the section to
 *  show and the OS window title; both update when the owner tab re-opens. */
export function DocsWindow(): React.JSX.Element {
  const [group, setGroup] = useState<DocGroup>(INITIAL_GROUP)

  useEffect(() => {
    document.title = INITIAL_TITLE
    return window.claudeTerm.onDocsSetGroup(({ group, title }) => {
      setGroup(group)
      document.title = title
    })
  }, [])

  return <DocsView tabId={TAB_ID} group={group} />
}
