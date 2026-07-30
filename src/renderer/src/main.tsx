import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DocsWindow } from './components/DocsWindow'
import { ConfigWindow } from './components/ConfigWindow'

// One renderer bundle serves every window: the main app, the detached docs
// viewer/editor (?docs=1) and the settings editor (?config=1). The main process
// picks which by query string when it loads index.html.
const params = new URLSearchParams(location.search)
const window_ =
  params.get('docs') === '1' ? (
    <DocsWindow />
  ) : params.get('config') === '1' ? (
    <ConfigWindow />
  ) : (
    <App />
  )

createRoot(document.getElementById('root')!).render(<StrictMode>{window_}</StrictMode>)
