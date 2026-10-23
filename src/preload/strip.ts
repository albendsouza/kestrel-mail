import { contextBridge, ipcRenderer } from 'electron'

import type { TabStripState } from '../main/window'

const api = {
  platform: process.platform,
  state: (): Promise<TabStripState> => ipcRenderer.invoke('kestrel:stripState'),
  onState: (cb: (state: TabStripState) => void) => {
    ipcRenderer.on('kestrel:tabs', (_e, state: TabStripState) => cb(state))
  },
  switchTab: (tabId: string) => ipcRenderer.invoke('kestrel:strip', { type: 'switch', tabId }),
  closeTab: (tabId: string) => ipcRenderer.invoke('kestrel:strip', { type: 'close', tabId }),
  newTab: () => ipcRenderer.invoke('kestrel:strip', { type: 'new' })
}

export type StripApi = typeof api

contextBridge.exposeInMainWorld('strip', api)
