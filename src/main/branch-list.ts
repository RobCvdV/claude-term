import type { BranchChoice, BranchGroup, BranchRef, TabStatus } from '../shared/types'
import { nameOf, splitFolderArg } from '../shared/status-folders'
import { rankByQuery } from './completions'

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
 *  branches for a folder (injected — see completions.listBranchRefs). */
export function workspaceBranchGroups(
  status: TabStatus | null,
  list: (cwd: string) => Promise<BranchRef[]>
): Promise<BranchGroup[]> {
  if (!status) return Promise.resolve([])
  return Promise.all(
    workspaceRepos(status).map(async (r) => ({ ...r, branches: await list(r.root) }))
  )
}

/** The tab's extra git repos other than `cwd`, as name-matchable folders. */
function extraRepoFolders(status: TabStatus | null, cwd: string): { path: string; name: string }[] {
  return (status?.extraRepos ?? [])
    .filter((r) => strip(r.root) !== strip(cwd))
    .map((r) => ({ path: r.root, name: nameOf(r.root) }))
}

/** `/switch` picks across the workspace: `cwd`'s branches bare, each extra
 *  repo's as `repo:branch`. */
export async function workspaceBranchChoices(
  status: TabStatus | null,
  cwd: string,
  list: (cwd: string) => Promise<BranchRef[]>,
  query: string
): Promise<BranchChoice[]> {
  const groups = await Promise.all([
    list(cwd).then((refs) => refs.map((b) => ({ key: b.name, branch: b.name, root: cwd }))),
    ...extraRepoFolders(status, cwd).map((f) =>
      list(f.path).then((refs) =>
        refs.map((b) => ({
          key: `${f.name}:${b.name}`,
          branch: b.name,
          root: f.path,
          repo: f.name
        }))
      )
    )
  ])
  // unfiltered: each repo gets a share, or a busy tab repo hides the others
  const share = query.trim() ? Infinity : Math.max(5, Math.floor(30 / groups.length))
  return rankByQuery(
    groups.flatMap((g) => g.slice(0, share)),
    (c) => c.key,
    query
  )
}

/** Where a `/switch` argument points: `repo:branch` into an extra repo, else `cwd`.
 *  Git ref names can't contain `:`, so the prefix is never part of a branch. */
export function resolveSwitchTarget(
  status: TabStatus | null,
  cwd: string,
  arg: string
): { root: string; branch: string; repo?: string } {
  const folders = extraRepoFolders(status, cwd)
  const hit = splitFolderArg(arg, folders)
  if (!hit) return { root: cwd, branch: arg.trim() }
  return { root: hit.path, branch: hit.rest.trim(), repo: nameOf(hit.path) }
}
