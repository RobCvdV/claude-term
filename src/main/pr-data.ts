import type { PrInfo } from '../shared/types'

// Pure mapping from the gh CLI / Bitbucket API shapes to PrInfo — kept free of
// electron imports so it's unit-testable (pr-list.ts owns the I/O).

/** Dropdown cap: only the most recent open PRs are shown. */
export const MAX_PRS = 10

interface GhPr {
  number?: number
  title?: string
  url?: string
}

/** `gh pr list --json number,title,url` output (newest first). */
export function mapGithubPrs(json: string, canMerge: boolean): PrInfo[] {
  const rows = JSON.parse(json) as GhPr[]
  return rows
    .filter((r) => r.number != null && !!r.title && !!r.url)
    .slice(0, MAX_PRS)
    .map((r) => ({ number: r.number!, title: r.title!, url: r.url!, canMerge }))
}

interface BbPr {
  id?: number
  title?: string
  links?: { html?: { href?: string } }
}

/** Bitbucket 2.0 pullrequests listing (sorted -created_on by the query). */
export function mapBitbucketPrs(body: unknown): PrInfo[] {
  const rows = (body as { values?: BbPr[] }).values ?? []
  return rows
    .filter((r) => r.id != null && !!r.title && !!r.links?.html?.href)
    .slice(0, MAX_PRS)
    .map((r) => ({ number: r.id!, title: r.title!, url: r.links!.html!.href!, canMerge: false }))
}
