// Bridge for the Google sign-in setup guide window.

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openExternal: (url: string) => ipcRenderer.invoke('kestrel:openExternal', url),
  setGoogleClient: (clientId: string, clientSecret: string) => ipcRenderer.invoke('kestrel:setGoogleClient', clientId, clientSecret),
  // Closes the guide and brings the main window forward.
  finish: () => ipcRenderer.invoke('kestrel:guideFinish')
}

export type GuideApi = typeof api

contextBridge.exposeInMainWorld('guide', api)
