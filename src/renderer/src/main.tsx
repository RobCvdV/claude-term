import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DocsWindow } from './components/DocsWindow'

// One renderer bundle serves both windows: the main app, and the detached file
// viewer/editor (?docs=1). The main process picks by query string when it loads
// index.html.
const params = new URLSearchParams(location.search)
const window_ = params.get('docs') === '1' ? <DocsWindow /> : <App />

createRoot(document.getElementById('root')!).render(<StrictMode>{window_}</StrictMode>)
