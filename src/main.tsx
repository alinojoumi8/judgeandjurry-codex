import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Styles for the juror journey screen. Imported here, not by the component, so tests can import the component.
import './components/analysis/jurorJourney.css'
import './components/analysis/deliberationView.css'
import './components/analysis/improvementPlan.css'
import './components/analysis/damages.css'
import App from './App.tsx'
import { installClientLogHandlers } from './clientLogger'

installClientLogHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
