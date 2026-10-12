/** Which Jira labels a repo's to-do tickets carry, and the links built on them.
 *  Pure — shared by the status bar and the main process. */

export const JIRA_SITE = 'https://mendrix.atlassian.net'

/** Labels per repo; repos not listed get no to-do list. */
export function jiraLabelsFor(repoName: string): string[] | null {
  if (repoName.startsWith('mendrix-tms')) return ['DriverAPI', 'Chat']
  switch (repoName) {
    case 'mendrix-mobile-next':
      return ['DriverNext', 'DriverNextFeedback']
    case 'mendrix-mobile-cordova':
      return ['Cordova']
    case 'mendrix-mobile-crossdock':
      return ['CrossDock']
    default:
      return null
  }
}

/** Unstarted MTX tickets with these labels that are free or already mine, in board order. */
export function todoJql(labels: string[]): string {
  const list = labels.map((l) => `"${l}"`).join(', ')
  return (
    `project = MTX AND labels in (${list}) AND status = "To Do" ` +
    `AND (assignee is EMPTY OR assignee = currentUser()) ORDER BY Rank ASC`
  )
}

export function todoSearchUrl(labels: string[]): string {
  return `${JIRA_SITE}/issues/?jql=${encodeURIComponent(todoJql(labels))}`
}

export function ticketUrl(key: string): string {
  return `${JIRA_SITE}/browse/${key}`
}
