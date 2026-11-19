import type { AppSettings, AppSettingsPatch } from './types'

export const SETTINGS_DEFAULTS: AppSettings = {
  tabKeysPerWindow: true,
  restoreWindowBounds: true,
  keepAwake: true,
  ciPolling: true,
  behindThreshold: 20,
  reviewQueue: true,
  claudeEditModel: 'sonnet',
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
    e2eFailed: true,
    ticketMoved: true,
    readyToMerge: true,
    reviewRequested: true,
    needsInput: false
  },
  workContexts: [
    {
      id: 'mendrix',
      name: 'MendriX',
      jira: { excludeStatuses: ['Deploy', 'Beta', 'Done'] },
      bitbucketWorkspaces: ['mendrix', 'mendrixmobile'],
      github: false
    },
    { id: 'personal', name: 'Personal', jira: null, bitbucketWorkspaces: [], github: true }
  ],
  board: { context: 'all', hiddenLanes: [], hiddenKinds: [], showHandedOff: false },
  boardWatch: true,
  worktreeSetup: {}
}

/** Apply a patch; `notify` merges per key so one switch never resets the rest. */
export function mergeSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  return { ...base, ...patch, notify: { ...base.notify, ...patch.notify } }
}
