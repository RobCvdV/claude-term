import type { AppSettings, AppSettingsPatch } from './types'

export const SETTINGS_DEFAULTS: AppSettings = {
  tabKeysPerWindow: true,
  restoreWindowBounds: true,
  keepAwake: true,
  ciPolling: true,
  behindThreshold: 20,
  reviewQueue: true,
  jiraTicketStatus: false,
  notify: {
    enabled: true,
    onlyWhenUnfocused: false,
    sound: true,
    prApproved: true,
    prChanges: true,
    prComments: true,
    ciFailed: true,
    ciFixed: true,
    ticketMoved: true,
    readyToMerge: true,
    reviewRequested: true,
    needsInput: false
  }
}

/** Apply a patch; `notify` merges per key so one switch never resets the rest. */
export function mergeSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  return { ...base, ...patch, notify: { ...base.notify, ...patch.notify } }
}
