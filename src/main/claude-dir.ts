import { homedir } from 'os'
import { join } from 'path'
import { shellEnvSync } from './shell-env'

/** Claude Code's config dir: the login shell's $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(): string {
  return shellEnvSync().CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}
