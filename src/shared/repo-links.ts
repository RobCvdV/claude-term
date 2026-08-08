/** Web URLs derived from a git remote + branch — shared by the renderer (status
 *  bar links) and the main process (PR lookup). Pure, no I/O. */

export type RepoHost = 'bitbucket' | 'github'

export interface RepoRef {
  host: RepoHost
  /** bitbucket workspace / github owner */
  owner: string
  repo: string
}

/** Mobile repos built by CircleCI. Their pipelines live under the workspace,
 *  not the repo, so the CircleCI link filters the workspace by branch. */
const CIRCLECI_REPOS = new Set([
  'mendrix-mobile-cordova',
  'mendrix-mobile-crossdock',
  'mendrix-mobile-next'
])

/** Branches that never have a PR of their own — skip the lookup for them. */
const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD'])

/** Accepts both ssh (`git@host:owner/repo.git`) and https remote URLs. */
export function parseRemote(remoteUrl: string): RepoRef | null {
  const m = /(bitbucket\.org|github\.com)[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    remoteUrl.trim()
  )
  if (!m) return null
  return {
    host: m[1] === 'github.com' ? 'github' : 'bitbucket',
    owner: m[2],
    repo: m[3]
  }
}

export function isTrunkBranch(branch: string): boolean {
  return TRUNK_BRANCHES.has(branch)
}

export function branchUrl(repo: RepoRef, branch: string): string {
  const b = encodeURIComponent(branch)
  return repo.host === 'bitbucket'
    ? `https://bitbucket.org/${repo.owner}/${repo.repo}/branch/${b}`
    : `https://github.com/${repo.owner}/${repo.repo}/tree/${b}`
}

/** All CircleCI runs of this branch, for the mobile repos only. */
export function circleCiUrl(repo: RepoRef, branch: string): string | null {
  if (repo.host !== 'bitbucket' || !CIRCLECI_REPOS.has(repo.repo)) return null
  // The filter value is kept literal (`:` and `/` unescaped) — that is the form
  // CircleCI itself produces and the one known to work.
  return `https://app.circleci.com/pipelines/bitbucket/${repo.owner}?filter=branch:equals:${branch}&useNewPipelines=true`
}

/** Jenkins job for this branch — MendriX TMS repos only (matched on the real
 *  folder name; display names have prefixes stripped). */
export function jenkinsJobUrl(folderName: string, branch: string): string | null {
  if (!folderName.startsWith('mendrix-tms')) return null
  const job = branch.startsWith('feature/') ? 'FeatureBuild' : 'BugfixBuild'
  return `https://ci.mendrix.nl/job/${job}/job/${encodeURIComponent(branch.replace(/\//g, '%2F'))}/`
}

/** GitHub Actions runs for this branch. */
export function actionsUrl(repo: RepoRef, branch: string): string | null {
  if (repo.host !== 'github') return null
  const q = encodeURIComponent(`branch:${branch}`)
  return `https://github.com/${repo.owner}/${repo.repo}/actions?query=${q}`
}

export function releasesUrl(repo: RepoRef): string | null {
  if (repo.host !== 'github') return null
  return `https://github.com/${repo.owner}/${repo.repo}/releases`
}
