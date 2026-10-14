import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import DeployContract from './DeployContract.jsx'

// Visit http://localhost:5173/?deploy to open the one-time deploy tool.
const showDeploy = new URLSearchParams(window.location.search).has('deploy')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {showDeploy ? <DeployContract /> : <App />}
  </StrictMode>,
)