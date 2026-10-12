import { describe, expect, it } from 'vitest'
import {
  adfToText,
  branchNameFor,
  findTicketBranch,
  mapTodos,
  MAX_DESCRIPTION_CHARS,
  startPrompt
} from './jira-todo-data'

describe('mapTodos', () => {
  it('maps issues and marks the ones assigned to me', () => {
    const body = {
      issues: [
        {
          key: 'MTX-1',
          fields: {
            summary: 'Crash on start',
            issuetype: { name: 'Bug' },
            priority: { name: 'High' },
            assignee: { accountId: 'me' }
          }
        },
        {
          key: 'MTX-2',
          fields: { summary: 'Free one', issuetype: { name: 'Task' }, assignee: null }
        },
        { key: 'MTX-3', fields: {} }
      ]
    }
    expect(mapTodos(body, 'me')).toEqual([
      { key: 'MTX-1', summary: 'Crash on start', type: 'Bug', priority: 'High', mine: true },
      { key: 'MTX-2', summary: 'Free one', type: 'Task', priority: null, mine: false }
    ])
    expect(mapTodos({}, 'me')).toEqual([])
  })
})

describe('adfToText', () => {
  it('puts each block on its own line and bullets list items', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps:' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open app' }] }]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tap stop' }] }]
            }
          ]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { text: '@Rob' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'thanks' }
          ]
        }
      ]
    }
    expect(adfToText(doc)).toBe('Steps:\n- open app\n- tap stop\nAsk @Rob\nthanks')
    expect(adfToText(null)).toBe('')
  })
})

describe('branchNameFor', () => {
  it('picks the prefix from the issue type and slugs the summary', () => {
    expect(branchNameFor('MTX-10', 'Bug', 'Crash when tapping "Stop" (Android)')).toBe(
      'bugfix/MTX-10-crash-when-tapping-stop-android'
    )
    expect(branchNameFor('MTX-11', 'Story', 'Nieuwe één-klik flow')).toBe(
      'feature/MTX-11-nieuwe-een-klik-flow'
    )
    expect(branchNameFor('MTX-12', 'Task', '')).toBe('chore/MTX-12')
  })

  it('keeps the slug short', () => {
    const name = branchNameFor('MTX-1', 'Bug', 'one two three four five six seven eight nine')
    expect(name).toBe('bugfix/MTX-1-one-two-three-four-five-six')
  })
})

describe('findTicketBranch', () => {
  it('prefers a local branch and never matches a longer ticket number', () => {
    expect(findTicketBranch('MTX-12', ['bugfix/MTX-123-x'], ['origin/bugfix/MTX-123-x'])).toBeNull()
    expect(findTicketBranch('MTX-12', ['bugfix/MTX-12-x'], ['origin/feature/MTX-12-y'])).toEqual({
      name: 'bugfix/MTX-12-x',
      remote: false
    })
  })

  it('falls back to the remote branch, without its origin/ prefix', () => {
    expect(findTicketBranch('MTX-12', ['main'], ['origin', 'origin/feature/MTX-12'])).toEqual({
      name: 'feature/MTX-12',
      remote: true
    })
  })
})

describe('startPrompt', () => {
  const base = {
    key: 'MTX-5',
    summary: 'Fix it',
    type: 'Bug',
    description: 'It breaks.',
    branch: 'bugfix/MTX-5-fix-it',
    base: 'origin/master',
    root: null
  }

  it('says where it switched and asks for a first glance', () => {
    const p = startPrompt({ ...base, created: true })
    expect(p).toContain("I'm starting on MTX-5 — Fix it (Bug).")
    expect(p).toContain('this repo to a new branch `bugfix/MTX-5-fix-it` from `origin/master`')
    expect(p).toContain('It breaks.')
    expect(p).toContain('setup step on new branches')
    const existing = startPrompt({ ...base, created: false, root: '/x/other' })
    expect(existing).toContain('the repo at /x/other to branch `bugfix/MTX-5-fix-it`')
    expect(existing).not.toContain('setup step')
  })

  it('cuts a long description', () => {
    const p = startPrompt({
      ...base,
      created: false,
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 50)
    })
    expect(p).toContain('[…cut off]')
  })
})
