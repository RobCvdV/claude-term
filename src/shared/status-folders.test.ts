import { describe, expect, it } from 'vitest'
import { addedFolders, matchExtraDir, statusFolders } from './status-folders'
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
  removedDirs: [],
  payload: null,
  git: null,
  ci: null,
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

  it('strips noisy repo-name prefixes from display names, not paths', () => {
    const s = status({
      cwd: '/dev/mendrix-mobile-cordova',
      payload: payload({
        current_dir: '/dev/mendrix-mobile-cordova',
        project_dir: '/dev/mendrix-mobile-cordova',
        added_dirs: ['/dev/mendrix-mobile-mmxlib', '/dev/eyo-cordova-background-geolocation']
      })
    })
    expect(statusFolders(s)).toEqual({
      home: { path: '/dev/mendrix-mobile-cordova', name: 'cordova' },
      others: [
        { path: '/dev/mendrix-mobile-mmxlib', name: 'mmxlib' },
        { path: '/dev/eyo-cordova-background-geolocation', name: 'background-geolocation' }
      ]
    })
  })

  it('keeps a name that IS just a prefix intact', () => {
    const s = status({ cwd: '/dev/mendrix-', payload: null })
    expect(statusFolders(s).home).toEqual({ path: '/dev/mendrix-', name: 'mendrix-' })
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

describe('addedFolders / removal', () => {
  const s = (over: Partial<TabStatus>): TabStatus =>
    status({
      cwd: '/dev/cordova',
      payload: payload({
        current_dir: '/dev/cordova',
        project_dir: '/dev/cordova',
        added_dirs: ['/dev/qedit']
      }),
      addedDirs: ['/dev/mmxlib'],
      ...over
    })

  it('lists the extra folders from both sources, /cd moves aside', () => {
    expect(addedFolders(s({}))).toEqual([
      { path: '/dev/qedit', name: 'qedit' },
      { path: '/dev/mmxlib', name: 'mmxlib' }
    ])
  })

  it('drops a removed folder even while the payload still reports it', () => {
    const removed = s({ removedDirs: ['/dev/qedit'] })
    expect(addedFolders(removed)).toEqual([{ path: '/dev/mmxlib', name: 'mmxlib' }])
    expect(statusFolders(removed).others).toEqual([{ path: '/dev/mmxlib', name: 'mmxlib' }])
  })

  it('leaves a /cd move alone — only extra folders are removable', () => {
    const moved = s({
      payload: payload({ current_dir: '/dev/elsewhere', project_dir: '/dev/cordova' }),
      removedDirs: ['/dev/elsewhere']
    })
    expect(addedFolders(moved)).toEqual([{ path: '/dev/mmxlib', name: 'mmxlib' }])
    expect(statusFolders(moved).others[0]).toEqual({ path: '/dev/elsewhere', name: 'elsewhere' })
  })
})

describe('matchExtraDir', () => {
  const extras = [
    { path: '/dev/mendrix-mobile-mmxlib', name: 'mmxlib' },
    { path: '/dev/qedit', name: 'qedit' }
  ]

  it('takes a full path, trailing slash or not', () => {
    expect(matchExtraDir('/dev/qedit', extras)).toBe('/dev/qedit')
    expect(matchExtraDir(' /dev/qedit/ ', extras)).toBe('/dev/qedit')
  })

  it('takes the name as the UI shows it, or the real folder name', () => {
    expect(matchExtraDir('mmxlib', extras)).toBe('/dev/mendrix-mobile-mmxlib')
    expect(matchExtraDir('MENDRIX-MOBILE-MMXLIB', extras)).toBe('/dev/mendrix-mobile-mmxlib')
  })

  it('refuses what it cannot pin down', () => {
    expect(matchExtraDir('', extras)).toBe(null)
    expect(matchExtraDir('/dev/other', extras)).toBe(null)
    expect(matchExtraDir('lib', extras)).toBe(null)
    const twins = [
      { path: '/a/ui', name: 'ui' },
      { path: '/b/ui', name: 'ui' }
    ]
    expect(matchExtraDir('ui', twins)).toBe(null)
  })
})
