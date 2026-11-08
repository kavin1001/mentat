import { createRoot } from 'react-dom/client'
import { App } from './App'
import { CallPrompt } from './CallPrompt'
import './styles.css'

createRoot(document.getElementById('root')!).render(location.hash === '#call-prompt' ? <CallPrompt /> : <App />)
