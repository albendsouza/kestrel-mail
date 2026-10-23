import path from 'path'

import { app } from 'electron'

// All bundled UI is served from this custom origin so it can carry a strict CSP
// and be told apart from anything loaded off the network.
export const APP_SCHEME = 'kestrel'
export const APP_HOST = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

export const distDir = (): string => path.join(app.getAppPath(), 'dist')
export const preloadPath = (name: 'tab' | 'strip' | 'guide'): string => path.join(distDir(), 'preload', `${name}.js`)
export const syncHostPath = (): string => path.join(distDir(), 'sync', 'host.js')
export const sortHostPath = (): string => path.join(distDir(), 'sort', 'host.js')

export const isDemo = (): boolean => process.env.KESTREL_DEMO === '1'
// Where Kestrel Sort looks for Laya's model (npm run laya:setup or Turn on smart sorting puts it there).
export const layaModelDir = (): string => process.env.KESTREL_LAYA_MODEL || path.join(app.getPath('userData'), 'models', 'laya-email')

export const UNDO_SEND_MS = 10_000
export const MAX_TABS_PER_WINDOW = 12
export const TAB_BAR_HEIGHT = 38
