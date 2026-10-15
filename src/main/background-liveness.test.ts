import { describe, expect, it } from 'vitest'
import type { RunningWork } from '../shared/types'
import { descendantCommands, parsePs, shellTaskAlive } from './background-liveness'

const ps = [
  '  10     1 /bin/zsh -il',
  '  11    10 /Users/me/.local/bin/claude --settings {}',
  `  12    11 /bin/zsh -c source snap.sh && eval 'ping -c 25 127.0.0.1 >/dev/null; echo "quote'"'"'s" done' < /dev/null`,
  '  13    12 ping -c 25 127.0.0.1',
  '  20     1 /bin/zsh -il',
  '  21    20 npm run dev'
].join('\n')

describe('background liveness', () => {
  const procs = parsePs(ps)

  it('collects only the processes under the tab', () => {
    expect(descendantCommands(procs, 10)).toHaveLength(3)
    expect(descendantCommands(procs, 20)).toEqual(['npm run dev'])
  })

  it('finds a background shell by its eval, quotes included', () => {
    const cmds = descendantCommands(procs, 10)
    const work = (label: string): RunningWork => ({ kind: 'shell', label, since: null })
    expect(shellTaskAlive(work(`ping -c 25 127.0.0.1 >/dev/null; echo "quote's" done`), cmds)).toBe(
      true
    )
    expect(shellTaskAlive(work('npm run dev'), cmds)).toBe(false)
  })
})
