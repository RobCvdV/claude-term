import type { JiraTodo, TicketStatus } from '../shared/types'

// Pure helpers for the Jira to-do dropdown and "Start branch" — no I/O, so
// they're unit-testable (jira-client.ts and jira-start.ts own the I/O).

interface RawIssue {
  key?: string
  fields?: {
    summary?: string
    issuetype?: { name?: string }
    priority?: { name?: string } | null
    assignee?: { accountId?: string } | null
  }
}

/** `/rest/api/3/search/jql` issues → dropdown rows, in the order Jira gave. */
export function mapTodos(body: unknown, myAccountId: string): JiraTodo[] {
  const issues = (body as { issues?: RawIssue[] }).issues ?? []
  return issues
    .filter((i) => !!i.key && !!i.fields?.summary)
    .map((i) => ({
      key: i.key!,
      summary: i.fields!.summary!,
      type: i.fields!.issuetype?.name ?? '',
      priority: i.fields!.priority?.name ?? null,
      mine: !!myAccountId && i.fields!.assignee?.accountId === myAccountId
    }))
}

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'codeBlock',
  'blockquote',
  'panel',
  'rule',
  'tableRow',
  'mediaSingle'
])

/** An ADF description as readable plain text: one line per block, list items bulleted. */
export function adfToText(node: unknown): string {
  const lines: string[] = []
  let line = ''
  const flush = (): void => {
    if (line.trim()) lines.push(line.trimEnd())
    line = ''
  }
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const { type, text, content, attrs } = n as {
      type?: string
      text?: string
      content?: unknown[]
      attrs?: { text?: string; shortName?: string; url?: string }
    }
    if (type === 'text') line += text ?? ''
    else if (type === 'hardBreak') flush()
    else if (type === 'mention') line += attrs?.text ?? ''
    else if (type === 'emoji') line += attrs?.shortName ?? ''
    else if (type === 'inlineCard') line += attrs?.url ?? ''
    else if (type === 'mediaSingle' || type === 'media') line += '[attachment]'
    if (type === 'listItem') {
      flush()
      line = '- '
    }
    if (Array.isArray(content)) content.forEach(walk)
    if (type && BLOCKS.has(type)) flush()
  }
  walk(node)
  flush()
  return lines.filter((l) => l !== '-').join('\n')
}

/** Branch prefix from the Jira issue type, as the MTX convention has it. */
export function branchPrefix(issueType: string): 'bugfix' | 'feature' | 'chore' {
  const t = issueType.toLowerCase()
  if (t === 'bug') return 'bugfix'
  if (t === 'task') return 'chore'
  return 'feature'
}

/** `<prefix>/MTX-123-short-summary`, kept to a handful of words. */
export function branchNameFor(key: string, issueType: string, summary: string): string {
  const slug = summary
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .reduce<string[]>((words, w) => {
      if (words.length < 6 && [...words, w].join('-').length <= 40) words.push(w)
      return words
    }, [])
    .join('-')
  return `${branchPrefix(issueType)}/${key}${slug ? `-${slug}` : ''}`
}

/** An existing branch for this ticket — MTX-12 never matches MTX-123. Local
 *  names win over `origin/…` ones, which come back without the remote prefix. */
export function findTicketBranch(
  key: string,
  local: string[],
  remote: string[]
): { name: string; remote: boolean } | null {
  const re = new RegExp(`(^|[^A-Za-z0-9])${key}(?![0-9])`)
  const hit = local.find((b) => re.test(b))
  if (hit) return { name: hit, remote: false }
  const r = remote
    .filter((b) => b.startsWith('origin/') && b !== 'origin/HEAD')
    .map((b) => b.slice('origin/'.length))
    .find((b) => re.test(b))
  return r ? { name: r, remote: true } : null
}

/** Description cap for the prompt — enough for a first read. */
export const MAX_DESCRIPTION_CHARS = 6000

/** The prompt handed to the tab's session once the branch is in place. */
export function startPrompt(opts: {
  key: string
  summary: string
  type: string
  description: string
  branch: string
  created: boolean
  base: string | null
  /** null = the tab's own repo */
  root: string | null
}): string {
  const where = opts.root ? `the repo at ${opts.root}` : 'this repo'
  const how = opts.created
    ? `a new branch \`${opts.branch}\`${opts.base ? ` from \`${opts.base}\`` : ''}`
    : `branch \`${opts.branch}\``
  let desc = opts.description.trim() || '(no description)'
  if (desc.length > MAX_DESCRIPTION_CHARS)
    desc = `${desc.slice(0, MAX_DESCRIPTION_CHARS)}\n[…cut off]`
  return [
    `I'm starting on ${opts.key} — ${opts.summary}${opts.type ? ` (${opts.type})` : ''}.`,
    `I switched ${where} to ${how}; files you read earlier may have changed — re-read before editing.`,
    '',
    'Ticket description:',
    desc,
    '',
    'Give me a first-glance idea of what this ticket is about, and one or two suggestions on how to approach it. Do not change any code yet.' +
      (opts.created
        ? " If this project's CLAUDE.md asks for a setup step on new branches, point it out."
        : '')
  ].join('\n')
}

interface RawIssueStatus {
  key?: string
  fields?: {
    summary?: string
    status?: { name?: string; statusCategory?: { key?: string } }
    assignee?: { displayName?: string } | null
  }
}

/** `/rest/api/3/issue/<key>?fields=summary,status,assignee` → TicketStatus. */
export function mapTicketStatus(body: unknown, key: string): TicketStatus | null {
  const issue = body as RawIssueStatus
  const name = issue.fields?.status?.name
  if (!name) return null
  const cat = issue.fields?.status?.statusCategory?.key
  return {
    key: issue.key ?? key,
    status: name,
    category: cat === 'done' ? 'done' : cat === 'new' ? 'todo' : 'progress',
    summary: issue.fields?.summary ?? '',
    assignee: issue.fields?.assignee?.displayName ?? null
  }
}
