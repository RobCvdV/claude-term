import { describe, expect, it } from 'vitest'
import { statusFolders } from './status-folders'
import type { StatuslinePayload, TabStatus } from '../../shared/types'

const status = (overrides: Partial<TabStatus>): TabStatus => ({
  tabId: 'tab-1',
  claudeActive: true,
  activity: 'idle',
  busySince: null,
  sessionId: 'sess-1',
  exitCode: null,
  cwd: '/dev/cordova',
  addedDirs: [],
  payload: null,
  git: null,
  ...overrides
})

const payload = (workspace: NonNullable<StatuslinePayload['workspace']>): StatuslinePayload => ({
  session_id: 'sess-1',
  workspace
})

describe('statusFolders', () => {
  it('shows only the tab folder when the session sits at home', () => {
    const s = status({
      payload: payload({ current_dir: '/dev/cordova', project_dir: '/dev/cordova' })
    })
    expect(statusFolders(s)).toEqual({
      home: { path: '/dev/cordova', name: 'cordova' },
      others: []
    })
  })

  it('handles a missing status', () => {
    expect(statusFolders(null)).toEqual({ home: null, others: [] })
  })

  // The user-visible case for multi-folder projects: the session never cd's,
  // it works across added_dirs (settings additionalDirectories or /add-dir).
  it('lists added dirs as secondary folders', () => {
    const s = status({
      payload: payload({
        current_dir: '/dev/cordova',
        project_dir: '/dev/cordova',
        added_dirs: ['/dev/mmxlib', '/dev/qedit']
      })
    })
    expect(statusFolders(s).others).toEqual([
      { path: '/dev/mmxlib', name: 'mmxlib' },
      { path: '/dev/qedit', name: 'qedit' }
    ])
  })

  it('shows a /cd-moved session (project+current elsewhere) once', () => {
    const s = status({
      payload: payload({ current_dir: '/dev/mmxlib', project_dir: '/dev/mmxlib' })
    })
    expect(statusFolders(s).others).toEqual([{ path: '/dev/mmxlib', name: 'mmxlib' }])
  })

  it('dedupes added dirs against home and drift, tolerating trailing slashes', () => {
    const s = status({
      payload: payload({
        current_dir: '/dev/mmxlib/',
        project_dir: '/dev/cordova',
        added_dirs: ['/dev/cordova/', '/dev/mmxlib']
      })
    })
    expect(statusFolders(s).others).toEqual([{ path: '/dev/mmxlib/', name: 'mmxlib' }])
  })

  it('falls back to the tab-level added dirs when there is no payload', () => {
    const s = status({ payload: null, addedDirs: ['/dev/mmxlib'] })
    expect(statusFolders(s).others).toEqual([{ path: '/dev/mmxlib', name: 'mmxlib' }])
  })

  // settings-sourced additionalDirectories never appear in the payload's
  // added_dirs (verified on CLI 2.1.221) — they reach the UI via the tab-level
  // record, merged alongside the payload's runtime /add-dir entries
  it('merges tab-level (settings-sourced) dirs with payload added_dirs', () => {
    const s = status({
      addedDirs: ['/dev/mmxlib', '/dev/qedit'],
      payload: payload({
        current_dir: '/dev/cordova',
        project_dir: '/dev/cordova',
        added_dirs: ['/dev/qedit', '/dev/extra']
      })
    })
    expect(statusFolders(s).others).toEqual([
      { path: '/dev/qedit', name: 'qedit' },
      { path: '/dev/extra', name: 'extra' },
      { path: '/dev/mmxlib', name: 'mmxlib' }
    ])
  })
})
