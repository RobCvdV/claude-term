import type { TabId } from './types'

/**
 * Vocabulary shared between the host and a companion device. Kept free of any
 * app imports beyond `TabId` so it can be extracted into its own package when
 * the mobile app lands.
 */

/** Which hook is holding a prompt open. The two differ in what they can answer:
 *  only PreToolUse's reason reaches the model (see docs/companion-hook-protocol.md). */
export type DecidingHook = 'PermissionRequest' | 'PreToolUse'

export type PromptKind = 'permission' | 'question' | 'plan'

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionSpec {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

/** A prompt the session is blocked on, held open while a device decides. */
export interface PendingPrompt {
  id: string
  tabId: TabId
  sessionId: string | null
  hook: DecidingHook
  kind: PromptKind
  toolName: string
  /** one line naming what is being asked about (the command, the file, …) */
  summary: string
  /** kind === 'question' */
  questions: QuestionSpec[] | null
  /** kind === 'plan' */
  plan: string | null
  planFilePath: string | null
  /** the untouched `tool_input`, for anything the fields above don't cover */
  toolInput: Record<string, unknown>
  createdAt: number
}

export type PromptDecision =
  /** approve — the tool runs */
  | { kind: 'allow' }
  /** reject. `reason` only reaches the model on a PreToolUse-parked prompt. */
  | { kind: 'deny'; reason?: string }
  /** answer a question, or send plan feedback — `text` reaches the model */
  | { kind: 'respond'; text: string }
  /** stop holding it; the terminal's own dialog is already on screen */
  | { kind: 'release' }

/** Why a prompt stopped being pending — devices use this to retract their card. */
export type PromptOutcome =
  | 'answered'
  /** handed back to the terminal, by a device or because none was listening */
  | 'released'
  /** the user answered in the terminal: the CLI closed the connection */
  | 'terminal'
  /** the host is shutting down */
  | 'shutdown'
