import { execFile } from 'child_process'

import type { BranchSwitchResult } from '../shared/types'

/** Run `git switch <branch>` in `cwd`. Never throws — failures come back as `error`. */
export function switchBranch(cwd: string, branch: string): Promise<BranchSwitchResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'switch', branch],
      { timeout: 10_000, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true })
        const msg = (stderr || err.message || 'git switch failed').trim()
        resolve({ ok: false, error: msg })
      }
    )
  })
}
