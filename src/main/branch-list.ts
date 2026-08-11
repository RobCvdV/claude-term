import type { BranchGroup, TabStatus } from '../shared/types'

const strip = (p: string): string => p.replace(/\/+$/, '')

/** The tab's git workspace repos: its own folder plus every extra repo. */
function workspaceRepos(status: TabStatus): { root: string; current: string | null }[] {
  const repos: { root: string; current: string | null }[] = []
  if (status.git) repos.push({ root: status.cwd, current: status.git.branch || null })
  for (const r of status.extraRepos) repos.push({ root: r.root, current: r.git.branch || null })
  return repos
}

/** Is `root` one of the tab's workspace repos? Guards renderer-supplied paths
 *  so `git switch` can only run where the status bar actually points. */
export function isWorkspaceRoot(status: TabStatus | null, root: string): boolean {
  if (!status) return false
  return workspaceRepos(status).some((r) => strip(r.root) === strip(root))
}

/** One BranchGroup per workspace repo; `list` supplies the non-current local
 *  branches for a folder (injected — see completions.listAllBranches). */
export function workspaceBranchGroups(
  status: TabStatus | null,
  list: (cwd: string) => Promise<string[]>
): Promise<BranchGroup[]> {
  if (!status) return Promise.resolve([])
  return Promise.all(
    workspaceRepos(status).map(async (r) => ({ ...r, branches: await list(r.root) }))
  )
}
