import { useEffect, useState } from 'react'
import type { AppSettings } from '../../shared/types'
import { SETTINGS_DEFAULTS } from '../../shared/app-settings-defaults'

/** Live app settings; defaults until the first answer arrives. */
export function useAppSettings(): AppSettings {
  const [s, setS] = useState<AppSettings>(SETTINGS_DEFAULTS)
  useEffect(() => {
    void window.claudeTerm.appSettings().then(setS)
    return window.claudeTerm.onAppSettings(setS)
  }, [])
  return s
}
