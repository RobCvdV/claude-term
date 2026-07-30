/** One thing Harper objects to, flattened so it survives postMessage. */
export interface Finding {
  /** character offsets into the linted text */
  start: number
  end: number
  /** Harper's LintKind, e.g. 'Agreement', 'Repetition', 'Style' */
  kind: string
  message: string
  /** replacement texts, best first */
  replacements: string[]
}

export type WorkerRequest =
  { type: 'init'; wasm: Uint8Array } | { type: 'lint'; id: number; text: string }

export type WorkerResponse =
  { type: 'ready'; ok: boolean } | { type: 'linted'; id: number; findings: Finding[] }
