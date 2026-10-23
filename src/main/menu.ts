import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  newTab: () => void
  newWindow: () => void
  closeTab: () => void
  reopenTab: () => void
  nextTab: () => void
  prevTab: () => void
  goToTab: (index: number) => void
  reload: () => void
  toggleDevTools: () => void
  // Commands handled inside the active tab's UI.
  command: (type: 'compose' | 'search' | 'palette' | 'help') => void
}

export function buildMenu(a: MenuActions): Menu {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Message', accelerator: 'CmdOrCtrl+Shift+N', click: () => a.command('compose') },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: a.newTab },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: a.newWindow },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: a.reopenTab },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: a.closeTab },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => a.command('palette') },
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: () => a.command('search') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => a.command('help') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: a.reload },
        ...(app.isPackaged ? [] : [{ label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: a.toggleDevTools }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: a.nextTab },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: a.prevTab },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: a.nextTab, visible: false },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: a.prevTab, visible: false },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => a.goToTab(i === 8 ? -1 : i),
          visible: false
        })),
        { type: 'separator' },
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
