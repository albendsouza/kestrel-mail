// Bridge for account tabs. MessagePorts can't cross contextBridge, so the port
// from the main process is forwarded into the page with window.postMessage.

import { contextBridge, ipcRenderer } from 'electron'

import type { SortingSetup } from '../shared/types'

const APP_ORIGIN = 'kestrel://app'

ipcRenderer.on('kestrel:port', event => {
  window.postMessage({ type: 'kestrel:port' }, APP_ORIGIN, event.ports)
})

const api = {
  context: () => ipcRenderer.invoke('kestrel:context'),
  connect: () => ipcRenderer.invoke('kestrel:connect'),
  useAccount: (accountId: string | null) => ipcRenderer.invoke('kestrel:useAccount', accountId),
  addDemoAccount: () => ipcRenderer.invoke('kestrel:addDemoAccount'),
  startTour: () => ipcRenderer.invoke('kestrel:startTour'),
  finishTour: () => ipcRenderer.invoke('kestrel:finishTour'),
  addGoogleAccount: () => ipcRenderer.invoke('kestrel:addGoogleAccount'),
  cancelSignIn: () => ipcRenderer.invoke('kestrel:cancelSignIn'),
  setGoogleClient: (clientId: string, clientSecret: string) => ipcRenderer.invoke('kestrel:setGoogleClient', clientId, clientSecret),
  openSetupGuide: () => ipcRenderer.invoke('kestrel:openSetupGuide'),
  reopenSignIn: () => ipcRenderer.invoke('kestrel:reopenSignIn'),
  signOut: (accountId: string): Promise<{ revoked: boolean }> => ipcRenderer.invoke('kestrel:signOut', accountId),
  openExternal: (url: string) => ipcRenderer.invoke('kestrel:openExternal', url),
  sortingSetup: (): Promise<SortingSetup> => ipcRenderer.invoke('kestrel:sortingSetup'),
  startSortingSetup: (): Promise<SortingSetup> => ipcRenderer.invoke('kestrel:startSortingSetup'),
  dismissSortingSetup: (): Promise<SortingSetup> => ipcRenderer.invoke('kestrel:dismissSortingSetup'),
  onSortingSetup: (cb: (state: SortingSetup) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: SortingSetup) => cb(state)
    ipcRenderer.on('kestrel:sortingSetup', listener)
    return () => {
      ipcRenderer.off('kestrel:sortingSetup', listener)
    }
  },
  onCommand:(cb: (command: { type: string; [k: string]: unknown }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, command: { type: string }) => cb(command)
    ipcRenderer.on('kestrel:command', listener)
    return () => {
      ipcRenderer.off('kestrel:command', listener)
    }
  }
}

export type KestrelApi = typeof api

contextBridge.exposeInMainWorld('kestrel', api)
