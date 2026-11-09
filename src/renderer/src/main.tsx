import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DocsWindow } from './components/DocsWindow'
import { MissionWindow } from './components/MissionWindow'

// One renderer bundle serves every window: the main app, the detached file
// viewer/editor (?docs=1) and Mission control (?mission=1). The main process
// picks by query string when it loads index.html.
const params = new URLSearchParams(location.search)
const window_ =
  params.get('docs') === '1' ? (
    <DocsWindow />
  ) : params.get('mission') === '1' ? (
    <MissionWindow />
  ) : (
    <App />
  )

createRoot(document.getElementById('root')!).render(<StrictMode>{window_}</StrictMode>)
