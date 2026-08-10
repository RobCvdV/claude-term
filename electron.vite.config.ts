import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // off Vite's default 5173 — electron-vite doesn't detect a foreign server
    // there and would load its page; strictPort makes a collision fail loudly
    server: { port: 5199, strictPort: true },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // the hunspell dictionaries ship as .aff/.dic next to an entry point that
        // reads them with node:fs — unusable in the renderer, and their `exports`
        // map hides the raw files, so reach into node_modules directly
        '@dict': resolve('node_modules')
      }
    },
    // harper.js lazily imports its wasm glue, so its worker has to be code-split
    // — and Vite's default IIFE worker format can't do that. Module workers are
    // fine for Monaco's and the spell worker too.
    worker: { format: 'es' },
    plugins: [react()]
  }
})
