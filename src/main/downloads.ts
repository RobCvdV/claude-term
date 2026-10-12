import type { RepoDownloads } from '../shared/types'
import { downloadsUrl, type RepoRef } from '../shared/repo-links'
import { bitbucketGet } from './bitbucket-api'

// Uploads are rare — no need to ask more often than this.
const TTL_MS = 10 * 60_000

const cache = new Map<string, { value: RepoDownloads | null; expiresAt: number }>()
const inflight = new Map<string, Promise<RepoDownloads | null>>()

/** The repo's Downloads page, or null when it has no files, isn't on
 *  Bitbucket, or can't be reached. */
export async function repoDownloads(repo: RepoRef): Promise<RepoDownloads | null> {
  const url = downloadsUrl(repo)
  if (!url) return null
  const hit = cache.get(url)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const running = inflight.get(url)
  if (running) return running
  const fetching = (async (): Promise<RepoDownloads | null> => {
    let value: RepoDownloads | null = null
    try {
      const body = (await bitbucketGet(
        `/repositories/${repo.owner}/${repo.repo}/downloads`,
        new URLSearchParams({ pagelen: '1', fields: 'size,values.name' })
      )) as { size?: number; values?: { name?: string }[] }
      const count = body.size ?? body.values?.length ?? 0
      if (count > 0) value = { url, count, latest: body.values?.[0]?.name ?? null }
    } catch {
      value = hit?.value ?? null
    }
    cache.set(url, { value, expiresAt: Date.now() + TTL_MS })
    inflight.delete(url)
    return value
  })()
  inflight.set(url, fetching)
  return fetching
}
