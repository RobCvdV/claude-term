import { describe, expect, it } from 'vitest'
import { jiraLabelsFor, todoJql, todoSearchUrl } from './jira-labels'

describe('jiraLabelsFor', () => {
  it('maps the driver repos to their labels', () => {
    expect(jiraLabelsFor('mendrix-mobile-next')).toEqual(['DriverNext', 'DriverNextFeedback'])
    expect(jiraLabelsFor('mendrix-tms')).toEqual(['DriverAPI', 'Chat'])
    expect(jiraLabelsFor('mendrix-tms-3')).toEqual(['DriverAPI', 'Chat'])
    expect(jiraLabelsFor('mendrix-mobile-cordova')).toEqual(['Cordova'])
    expect(jiraLabelsFor('mendrix-mobile-crossdock')).toEqual(['CrossDock'])
  })

  it('gives other repos no list', () => {
    expect(jiraLabelsFor('qedit')).toBeNull()
    expect(jiraLabelsFor('mendrix-mobile-mmxlib')).toBeNull()
  })
})

describe('todoJql', () => {
  it('asks for free-or-mine To Do tickets in board order', () => {
    expect(todoJql(['Cordova'])).toBe(
      'project = MTX AND labels in ("Cordova") AND status = "To Do" ' +
        'AND (assignee is EMPTY OR assignee = currentUser()) ORDER BY Rank ASC'
    )
    expect(todoSearchUrl(['A', 'B'])).toContain(encodeURIComponent('labels in ("A", "B")'))
  })
})
