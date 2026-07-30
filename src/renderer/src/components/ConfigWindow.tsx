import { useEffect, useState } from 'react'
import { ConfigView } from './ConfigView'

const params = new URLSearchParams(location.search)
const TAB_ID = params.get('tabId') ?? ''
const INITIAL_TITLE = params.get('title') ?? 'Settings'

/** Top-level component for the standalone settings window. Re-scans when the
 *  owner tab re-opens it, since its roots may have gained an /add-dir folder. */
export function ConfigWindow(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    document.title = INITIAL_TITLE
    return window.claudeTerm.onConfigRefresh(() => setReloadKey((n) => n + 1))
  }, [])

  return <ConfigView tabId={TAB_ID} reloadKey={reloadKey} />
}
