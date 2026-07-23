import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DocsWindow } from './components/DocsWindow'

// One renderer bundle serves both windows: the main app, and the detached docs
// viewer/editor (opened with ?docs=1 by the main process).
const isDocsWindow = new URLSearchParams(location.search).get('docs') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDocsWindow ? <DocsWindow /> : <App />}</StrictMode>
)
