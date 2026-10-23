// A window holds a tab strip view on top and one WebContentsView per tab.
// Each tab is bound to one account (or none, which shows the account picker).

import { BaseWindow, WebContentsView, nativeTheme } from 'electron'
import { randomUUID } from 'crypto'

import { APP_ORIGIN, MAX_TABS_PER_WINDOW, TAB_BAR_HEIGHT, preloadPath } from './config'
import { isAppUrl, openExternalSafely } from './security'

import type { SavedWindow } from './store'

export interface Tab {
  id: string
  accountId: string | null
  view: WebContentsView
  title: string
  unread: number
}

export interface TabStripState {
  tabs: { id: string; title: string; unread: number; active: boolean }[]
}

export interface WindowHooks {
  onChange: () => void
  onClosed: (w: AppWindow) => void
  accountLabel: (accountId: string | null) => string
}

const BACKGROUND = { dark: '#16171b', light: '#ffffff' }

export class AppWindow {
  readonly window: BaseWindow
  readonly strip: WebContentsView
  tabs: Tab[] = []
  activeTab: Tab | null = null
  private closedTabs: (string | null)[] = []

  constructor(
    private readonly hooks: WindowHooks,
    saved?: SavedWindow
  ) {
    const bg = nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
    this.window = new BaseWindow({
      ...(saved?.bounds ?? { width: 1280, height: 820 }),
      minWidth: 760,
      minHeight: 420,
      title: 'Kestrel',
      backgroundColor: bg,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      show: false
    })

    this.strip = new WebContentsView({
      webPreferences: { preload: preloadPath('strip'), sandbox: true, contextIsolation: true }
    })
    this.strip.setBackgroundColor(bg)
    lockToUrl(this.strip.webContents, `${APP_ORIGIN}/strip.html`)
    void this.strip.webContents.loadURL(`${APP_ORIGIN}/strip.html`)
    this.window.contentView.addChildView(this.strip)

    this.window.on('resize', () => this.layout())
    this.window.on('focus', () => this.activeTab?.view.webContents.focus())
    this.window.on('closed', () => this.hooks.onClosed(this))

    const tabs = saved?.tabs.length ? saved.tabs : [{ accountId: null }]
    tabs.forEach(t => this.addTab(t.accountId, { activate: false }))
    this.activate(this.tabs[Math.min(saved?.activeIndex ?? 0, this.tabs.length - 1)])
    this.layout()
    this.window.show()
  }

  get id(): number {
    return this.window.id
  }

  addTab(accountId: string | null, { activate = true }: { activate?: boolean } = {}): Tab {
    if (this.tabs.length >= MAX_TABS_PER_WINDOW) {
      // Reuse the last tab instead of growing past the limit.
      const last = this.tabs[this.tabs.length - 1]
      this.bindAccount(last, accountId)
      if (activate) this.activate(last)
      return last
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath('tab'),
        sandbox: true,
        contextIsolation: true,
        spellcheck: true
      }
    })
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light)
    const tab: Tab = { id: randomUUID(), accountId, view, title: this.hooks.accountLabel(accountId), unread: 0 }
    guardNavigation(view.webContents)
    view.webContents.on('page-title-updated', (_e, title) => {
      tab.title = title || this.hooks.accountLabel(tab.accountId)
      this.hooks.onChange()
    })
    view.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') setTimeout(() => !view.webContents.isDestroyed() && view.webContents.reload(), 500)
    })
    void view.webContents.loadURL(`${APP_ORIGIN}/app.html`)
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    this.tabs.push(tab)
    if (activate) this.activate(tab)
    this.hooks.onChange()
    return tab
  }

  bindAccount(tab: Tab, accountId: string | null): void {
    tab.accountId = accountId
    tab.title = this.hooks.accountLabel(accountId)
    tab.unread = 0
    tab.view.webContents.reload()
    this.hooks.onChange()
  }

  activate(tab: Tab | undefined): void {
    if (!tab) return
    for (const t of this.tabs) t.view.setVisible(t === tab)
    this.activeTab = tab
    this.layout()
    tab.view.webContents.focus()
    this.hooks.onChange()
  }

  activateIndex(i: number): void {
    this.activate(i === -1 ? this.tabs[this.tabs.length - 1] : this.tabs[i])
  }

  cycle(delta: number): void {
    if (!this.activeTab || this.tabs.length < 2) return
    const i = this.tabs.indexOf(this.activeTab)
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length])
  }

  closeTab(tab: Tab | null = this.activeTab): void {
    if (!tab) return
    if (this.tabs.length === 1) {
      this.window.close()
      return
    }
    const i = this.tabs.indexOf(tab)
    this.tabs.splice(i, 1)
    this.closedTabs.push(tab.accountId)
    this.window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    if (this.activeTab === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)])
    this.hooks.onChange()
  }

  reopenClosedTab(): void {
    const accountId = this.closedTabs.pop()
    if (accountId !== undefined) this.addTab(accountId)
  }

  tabByContents(contents: Electron.WebContents): Tab | undefined {
    return this.tabs.find(t => t.view.webContents === contents)
  }

  layout(): void {
    const { width, height } = this.window.getContentBounds()
    this.strip.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT })
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT })
  }

  stripState(): TabStripState {
    return {
      tabs: this.tabs.map(t => ({ id: t.id, title: t.title, unread: t.unread, active: t === this.activeTab }))
    }
  }

  toJson(): SavedWindow {
    return {
      bounds: this.window.getNormalBounds(),
      tabs: this.tabs.map(t => ({ accountId: t.accountId })),
      activeIndex: this.activeTab ? this.tabs.indexOf(this.activeTab) : 0
    }
  }
}

// Bundled pages never navigate away; links go to the system browser instead.
function guardNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })
  contents.on('will-frame-navigate', event => {
    // Email iframes are srcdoc; block them from navigating anywhere in-app.
    if (!event.isMainFrame && !event.url.startsWith('about:')) {
      event.preventDefault()
      openExternalSafely(event.url)
    }
  })
}

export function lockToUrl(contents: Electron.WebContents, allowed: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (url !== allowed) event.preventDefault()
  })
}
