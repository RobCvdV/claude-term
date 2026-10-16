import type { IntegrationStatus } from '../shared/types'
import { bitbucketCreds } from './bitbucket-api'
import { jiraStatus } from './jira-client'
import { githubLogin } from './pr-list'
import { loginShellEnv } from './shell-env'

export async function integrationStatus(): Promise<IntegrationStatus> {
  const env = await loginShellEnv()
  return {
    jira: jiraStatus(),
    bitbucket: !!(await bitbucketCreds()),
    github: await githubLogin(),
    circleci: !!(env['CIRCLECI_TOKEN'] ?? env['CIRCLE_TOKEN']),
    jenkins: !!(env['JENKINS_USER'] && (env['JENKINS_API_TOKEN'] ?? env['JENKINS_TOKEN']))
  }
}
