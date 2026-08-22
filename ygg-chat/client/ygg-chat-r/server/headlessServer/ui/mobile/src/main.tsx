import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const applyThemePreference = () => {
  const root = document.documentElement

  // Let CSS media queries control dark mode via prefers-color-scheme.
  root.removeAttribute('data-theme')
}

applyThemePreference()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Missing #root element for mobile app')
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
