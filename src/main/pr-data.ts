import type { PrInfo } from '../shared/types'

// Pure mapping from the gh CLI / Bitbucket API shapes to PrInfo — kept free of
// electron imports so it's unit-testable (pr-list.ts owns the I/O).

/** Dropdown cap: only the most recent open PRs are shown. */
export const MAX_PRS = 10

interface GhPr {
  number?: number
  title?: string
  url?: string
  author?: { login?: string; is_bot?: boolean }
}

/**
 * `gh pr list --json number,title,url,author` output (newest first). `viewer` is
 * the signed-in login; without it no PR is claimed as the user's own — better
 * unmarked than wrongly marked.
 */
export function mapGithubPrs(json: string, canMerge: boolean, viewer?: string | null): PrInfo[] {
  const rows = JSON.parse(json) as GhPr[]
  return rows
    .filter((r) => r.number != null && !!r.title && !!r.url)
    .slice(0, MAX_PRS)
    .map((r) => ({
      number: r.number!,
      title: r.title!,
      url: r.url!,
      canMerge,
      mine: !!viewer && r.author?.login === viewer
    }))
}

interface BbPr {
  id?: number
  title?: string
  links?: { html?: { href?: string } }
  author?: { uuid?: string }
}

/** Bitbucket 2.0 pullrequests listing (sorted -created_on by the query).
 *  `viewerUuid` comes from `/2.0/user` — Bitbucket identifies people by uuid,
 *  display names are not unique enough to compare. */
export function mapBitbucketPrs(body: unknown, viewerUuid?: string | null): PrInfo[] {
  const rows = (body as { values?: BbPr[] }).values ?? []
  return rows
    .filter((r) => r.id != null && !!r.title && !!r.links?.html?.href)
    .slice(0, MAX_PRS)
    .map((r) => ({
      number: r.id!,
      title: r.title!,
      url: r.links!.html!.href!,
      canMerge: false,
      mine: !!viewerUuid && r.author?.uuid === viewerUuid
    }))
}
