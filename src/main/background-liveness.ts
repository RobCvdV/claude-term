import type { RunningWork } from '../shared/types'

interface Proc {
  pid: number
  ppid: number
  command: string
}

/** `ps -A -ww -o pid=,ppid=,command=` output. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return procs
}

/** Command lines of every process under `rootPid`. */
export function descendantCommands(procs: Proc[], rootPid: number): string[] {
  const children = new Map<number, Proc[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const out: string[] = []
  const stack = [rootPid]
  while (stack.length) {
    for (const child of children.get(stack.pop() as number) ?? []) {
      out.push(child.command)
      stack.push(child.pid)
    }
  }
  return out
}

/** Whether a background shell task is still running among `commands`. Claude
 *  Code runs it as `zsh -c "… eval '<command>' …"`, quotes escaped for that. */
export function shellTaskAlive(work: RunningWork, commands: string[]): boolean {
  const escaped = work.label.replace(/'/g, `'"'"'`)
  return commands.some((c) => c.includes(`eval '${escaped}`) || c.includes(work.label))
}
