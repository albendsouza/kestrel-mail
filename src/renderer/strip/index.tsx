import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { StripApi } from '../../preload/strip'
import type { TabStripState } from '../../main/window'

declare global {
  interface Window {
    strip: StripApi
  }
}

function Strip() {
  const [state, setState] = useState<TabStripState>({ tabs: [] })
  useEffect(() => {
    window.strip.onState(setState)
    void window.strip.state().then(s => s && setState(s))
  }, [])
  return (
    <div className={`strip ${window.strip.platform === 'darwin' ? 'mac' : ''}`}>
      {state.tabs.map(t => (
        <div
          key={t.id}
          className={`tab ${t.active ? 'active' : ''}`}
          onMouseDown={e => e.button === 0 && void window.strip.switchTab(t.id)}
          onAuxClick={e => e.button === 1 && void window.strip.closeTab(t.id)}
          title={t.title}
        >
          <span className="tab-title">{t.title}</span>
          {t.unread > 0 && <span className="tab-count">{t.unread}</span>}
          <button
            className="tab-close"
            aria-label="Close tab"
            onMouseDown={e => e.stopPropagation()}
            onClick={() => void window.strip.closeTab(t.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button className="new-tab" aria-label="New tab" onClick={() => void window.strip.newTab()}>
        +
      </button>
      <div className="drag-fill" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Strip />)
