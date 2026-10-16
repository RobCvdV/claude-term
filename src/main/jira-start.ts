import { execFile } from 'child_process'
import type { StartTicketResult } from '../shared/types'
import { claimTicket, fetchTicket } from './jira-client'
import { forgetTicket } from './ticket-status'
import { branchNameFor, findTicketBranch, startPrompt } from './jira-todo-data'

function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())
    )
  )
}

const refs = async (cwd: string, prefix: string): Promise<string[]> =>
  (await git(cwd, ['for-each-ref', '--format=%(refname:short)', prefix]))
    .split('\n')
    .filter(Boolean)

/** What a new branch starts from: the remote's default branch, never whatever is checked out. */
async function baseRef(cwd: string, remote: string[]): Promise<string | null> {
  try {
    return await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  } catch {
    return (
      ['origin/main', 'origin/master', 'origin/develop'].find((b) => remote.includes(b)) ?? null
    )
  }
}

/**
 * "Start branch" on a to-do ticket: switch `cwd` to the ticket's branch
 * (creating it off the default branch when there is none), then put the ticket
 * on my name in Active. The branch decides success; Jira hiccups are warnings.
 */
export async function startTicket(
  cwd: string,
  key: string,
  root: string | null
): Promise<StartTicketResult> {
  try {
    const ticket = await fetchTicket(key)
    await git(cwd, ['fetch', '--prune', 'origin'], 30_000).catch(() => {
      // offline → work from the refs we have
    })
    const local = await refs(cwd, 'refs/heads')
    const remote = await refs(cwd, 'refs/remotes/origin')
    const existing = findTicketBranch(ticket.key, local, remote)
    let branch: string
    let created = false
    let base: string | null = null
    if (existing) {
      branch = existing.name
      const current = await git(cwd, ['branch', '--show-current'])
      if (current !== branch) await git(cwd, ['switch', branch])
    } else {
      branch = branchNameFor(ticket.key, ticket.type, ticket.summary)
      base = await baseRef(cwd, remote)
      await git(cwd, ['switch', '-c', branch, ...(base ? ['--no-track', base] : [])])
      created = true
    }
    const warnings = await claimTicket(ticket)
    forgetTicket(ticket.key)
    const prompt = startPrompt({
      key: ticket.key,
      summary: ticket.summary,
      type: ticket.type,
      description: ticket.description,
      branch,
      created,
      base,
      root
    })
    return { ok: true, branch, created, prompt, warnings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
