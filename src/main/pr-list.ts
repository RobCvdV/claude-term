import { execFile } from 'child_process'
import { BrowserWindow, dialog, Menu, shell } from 'electron'
import type { PrInfo } from '../shared/types'
import type { RepoRef } from '../shared/repo-links'
import { loginShellEnv } from './shell-env'
import { mapBitbucketPrs, mapGithubPrs, MAX_PRS } from './pr-data'

/** How long a fetched PR list stays good. */
const TTL_MS = 60_000
const TTL_ERROR_MS = 300_000

interface Entry {
  prs: PrInfo[]
  expiresAt: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<PrInfo[]>>()

const repoKey = (repo: RepoRef): string => `${repo.host}/${repo.owner}/${repo.repo}`

/**
 * The repo's open PRs, most recent first, capped at MAX_PRS. Serves a cached
 * answer while fresh; errors resolve to the stale list (or empty) so the
 * dropdown never rejects.
 */
export async function listOpenPrs(cwd: string, repo: RepoRef): Promise<PrInfo[]> {
  const key = repoKey(repo)
  const entry = cache.get(key)
  if (entry && entry.expiresAt > Date.now()) return entry.prs
  const running = inflight.get(key)
  if (running) return running
  const fetching = (async (): Promise<PrInfo[]> => {
    try {
      const prs = repo.host === 'github' ? await fetchGithub(cwd) : await fetchBitbucket(repo)
      cache.set(key, { prs, expiresAt: Date.now() + TTL_MS })
      return prs
    } catch {
      const stale = cache.get(key)?.prs ?? []
      cache.set(key, { prs: stale, expiresAt: Date.now() + TTL_ERROR_MS })
      return stale
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, fetching)
  return fetching
}

function gh(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env, timeout: 15_000, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    )
  })
}

async function fetchGithub(cwd: string): Promise<PrInfo[]> {
  const env = await loginShellEnv()
  const [listOut, merge, viewer] = await Promise.all([
    gh(
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        String(MAX_PRS),
        '--json',
        'number,title,url,author'
      ],
      cwd,
      env
    ),
    githubMergeInfo(cwd, env),
    githubViewer(cwd, env)
  ])
  return mapGithubPrs(listOut, merge.canMerge, viewer)
}

// Who the gh CLI is signed in as. One login per machine in practice, and it
// never changes mid-session — asked once, then remembered (null = we could not
// tell, which leaves every PR unmarked).
let viewerLogin: string | null | undefined

async function githubViewer(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (viewerLogin !== undefined) return viewerLogin
  try {
    viewerLogin = (await gh(['api', 'user', '--jq', '.login'], cwd, env)).trim() || null
  } catch {
    viewerLogin = null // not signed in → nothing is "mine"
  }
  return viewerLogin
}

interface MergeInfo {
  canMerge: boolean
  /** merge strategy flag for `gh pr merge`, picked from what the repo allows */
  flag: '--squash' | '--merge' | '--rebase'
}

// Push access and allowed merge methods change rarely — cache them for a day.
const mergeInfoCache = new Map<string, { info: MergeInfo; expiresAt: number }>()

async function githubMergeInfo(cwd: string, env: NodeJS.ProcessEnv): Promise<MergeInfo> {
  const hit = mergeInfoCache.get(cwd)
  if (hit && hit.expiresAt > Date.now()) return hit.info
  let info: MergeInfo = { canMerge: false, flag: '--squash' }
  try {
    const out = await gh(
      [
        'repo',
        'view',
        '--json',
        'viewerPermission,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'
      ],
      cwd,
      env
    )
    const repo = JSON.parse(out) as {
      viewerPermission?: string
      squashMergeAllowed?: boolean
      mergeCommitAllowed?: boolean
      rebaseMergeAllowed?: boolean
    }
    info = {
      canMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission ?? ''),
      flag: repo.squashMergeAllowed ? '--squash' : repo.mergeCommitAllowed ? '--merge' : '--rebase'
    }
  } catch {
    // no gh auth / not a github repo → just no Merge item
  }
  mergeInfoCache.set(cwd, { info, expiresAt: Date.now() + 24 * 3600_000 })
  return info
}

async function fetchBitbucket(repo: RepoRef): Promise<PrInfo[]> {
  const env = await loginShellEnv()
  const email = env.BITBUCKET_EMAIL
  const token = env.BITBUCKET_API_TOKEN
  if (!email || !token) throw new Error('no bitbucket credentials')
  const params = new URLSearchParams({
    state: 'OPEN',
    sort: '-created_on',
    pagelen: String(MAX_PRS),
    fields: 'values.id,values.title,values.links.html.href,values.author.uuid'
  })
  const res = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${repo.owner}/${repo.repo}/pullrequests?${params}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    }
  )
  if (!res.ok) throw new Error(`bitbucket ${res.status}`)
  return mapBitbucketPrs(await res.json(), await bitbucketViewer(email, token))
}

// Our own Bitbucket uuid, for the same reason as githubViewer above.
let viewerUuid: string | null | undefined

async function bitbucketViewer(email: string, token: string): Promise<string | null> {
  if (viewerUuid !== undefined) return viewerUuid
  try {
    const res = await fetch('https://api.bitbucket.org/2.0/user?fields=uuid', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })
    viewerUuid = res.ok ? (((await res.json()) as { uuid?: string }).uuid ?? null) : null
  } catch {
    viewerUuid = null
  }
  return viewerUuid
}

/**
 * Right-click menu for one PR in the dropdown: Open in Browser, and — for a
 * GitHub repo the user can push to — Merge, behind a confirmation dialog
 * (merging to main triggers the release pipeline on some repos).
 */
export function showPrContextMenu(
  win: BrowserWindow,
  cwd: string,
  repo: RepoRef,
  pr: PrInfo
): void {
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Open in Browser',
      click: () => {
        if (/^https?:\/\//i.test(pr.url)) void shell.openExternal(pr.url)
      }
    }
  ]
  if (pr.canMerge && repo.host === 'github') {
    items.push(
      { type: 'separator' },
      { label: `Merge #${pr.number}…`, click: () => void confirmAndMerge(win, cwd, repo, pr) }
    )
  }
  Menu.buildFromTemplate(items).popup({ window: win })
}

async function confirmAndMerge(
  win: BrowserWindow,
  cwd: string,
  repo: RepoRef,
  pr: PrInfo
): Promise<void> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Merge'],
    defaultId: 0,
    cancelId: 0,
    message: `Merge PR #${pr.number}?`,
    detail: `${pr.title}\n\nMerges into the base branch — this may trigger a release.`
  })
  if (response !== 1) return
  const env = await loginShellEnv()
  const { flag } = await githubMergeInfo(cwd, env)
  try {
    await gh(['pr', 'merge', String(pr.number), flag, '--delete-branch'], cwd, env)
    cache.delete(repoKey(repo)) // next dropdown open shows the fresh list
  } catch (err) {
    dialog.showMessageBox(win, {
      type: 'error',
      message: `Merging PR #${pr.number} failed`,
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}
