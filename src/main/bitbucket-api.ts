import { loginShellEnv } from './shell-env'

/** GET a Bitbucket 2.0 API path (`/repositories/...`) with the shell's
 *  BITBUCKET_EMAIL / BITBUCKET_API_TOKEN; throws on missing creds or non-2xx. */
export async function bitbucketGet(path: string, params?: URLSearchParams): Promise<unknown> {
  const creds = await bitbucketCreds()
  if (!creds) throw new Error('no bitbucket credentials')
  const res = await fetch(`https://api.bitbucket.org/2.0${path}${params ? `?${params}` : ''}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`bitbucket ${res.status}`)
  return res.json()
}

export async function bitbucketCreds(): Promise<{ email: string; token: string } | null> {
  const env = await loginShellEnv()
  const email = env.BITBUCKET_EMAIL
  const token = env.BITBUCKET_API_TOKEN
  return email && token ? { email, token } : null
}
