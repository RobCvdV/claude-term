import type { ClaudeTermApi } from './index'

declare global {
  interface Window {
    claudeTerm: ClaudeTermApi
  }
}

export {}
