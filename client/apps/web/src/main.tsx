import '@vibechat/ui/styles.css'
import { App } from '@vibechat/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { platform } from './platform'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

createRoot(root).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
)
