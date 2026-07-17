/// <reference types="vite/client" />

// We import Monaco's ESM editor.api entry directly (to skip the bundled
// languages), but Monaco's package `exports` map doesn't expose that deep path
// to TypeScript's bundler resolution. Its types are identical to the package
// root, so re-export them for the deep specifiers we use.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
declare module 'monaco-editor/esm/vs/editor/editor.all.js'
