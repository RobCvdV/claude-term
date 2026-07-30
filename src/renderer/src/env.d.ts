/// <reference types="vite/client" />

// We import Monaco's ESM editor.api entry directly (to skip the bundled
// languages), but Monaco's package `exports` map doesn't expose that deep path
// to TypeScript's bundler resolution. Its types are identical to the package
// root, so re-export them for the deep specifiers we use.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
declare module 'monaco-editor/esm/vs/editor/editor.all.js'

// Internal, but the only way to install service overrides before Monaco's first
// API call locks the service collection (see monaco-setup).
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices' {
  export const StandaloneServices: {
    initialize(overrides: Record<string, unknown>): unknown
  }
}

// nspell ships no types. Only the three methods we use.
declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string, model?: string): NSpell
  }
  export default function nspell(aff: string, dic: string): NSpell
}

// Hunspell dictionary data, imported raw through the `@dict` alias.
declare module '@dict/*' {
  const content: string
  export default content
}
