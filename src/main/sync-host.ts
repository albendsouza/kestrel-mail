// Starts the sync and sort utility processes and brokers MessagePorts between
// them and the tabs.

import { app, MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import path from 'path'

import { sortHostPath, syncHostPath } from './config'

import type { Account } from '../shared/types'
import type { SortCommand } from '../sort/host'
import type { HostCommand, HostReport } from '../sync/host'

const MAX_RESTARTS = 5

export class SyncHost {
  private child: UtilityProcess | null = null
  private sorter: UtilityProcess | null = null
  private stopping = false
  private restarts = 0
  private accounts: Account[] = []
  // Tabs to reconnect after the sync process restarts.
  private connections = new Set<{ accountId: string; contents: WebContents }>()

  constructor(
    private readonly handlers: {
      token: (accountId: string) => Promise<string>
      badge: (accountId: string, unread: number) => void
      newMail: (accountId: string, threads: Extract<HostReport, { type: 'newMail' }>['threads']) => void
      fatal: (message: string) => void
    }
  ) {}

  start(accounts: Account[]): void {
    this.accounts = accounts
    this.spawn()
    this.spawnSorter()
  }

  // Kestrel Sort exits on its own when idle (to free the model's memory), so it's
  // simply started again; it only loads the model once there's mail to sort.
  private spawnSorter(): void {
    if (this.stopping) return
    const child = utilityProcess.fork(sortHostPath(), [], { serviceName: 'Kestrel Sort', stdio: 'inherit' })
    this.sorter = child
    const modelDir = process.env.KESTREL_LAYA_MODEL || path.join(app.getPath('userData'), 'models', 'laya-email')
    child.postMessage({ type: 'init', modelDir } satisfies SortCommand)
    child.on('exit', code => {
      if (this.sorter !== child) return
      this.sorter = null
      setTimeout(() => this.spawnSorter(), code === 0 ? 0 : 2000)
    })
    this.linkSorter()
  }

  // A channel between Sync and Sort; either end restarting gets a fresh one.
  private linkSorter(): void {
    if (!this.child || !this.sorter) return
    const { port1, port2 } = new MessageChannelMain()
    this.sorter.postMessage({ type: 'connect' } satisfies SortCommand, [port2])
    this.send({ type: 'sorter' }, [port1])
  }

  private send(cmd: HostCommand, transfer: Electron.MessagePortMain[] = []): void {
    this.child?.postMessage(cmd, transfer)
  }

  private spawn(): void {
    const child = utilityProcess.fork(syncHostPath(), [], { serviceName: 'Kestrel Sync', stdio: 'inherit' })
    this.child = child
    child.on('message', (report: HostReport) => this.onReport(report))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      if (code === 0 || this.restarts >= MAX_RESTARTS) {
        if (code !== 0) this.handlers.fatal(`The sync process crashed ${this.restarts} times.`)
        return
      }
      this.restarts++
      setTimeout(() => this.spawn(), 1000 * this.restarts)
    })
    this.send({ type: 'init', dataDir: path.join(app.getPath('userData'), 'sync'), accounts: this.accounts })
    this.linkSorter()
    // Each tab holds a port to the old process; hand them fresh ones.
    for (const c of [...this.connections]) {
      if (c.contents.isDestroyed()) this.connections.delete(c)
      else this.transfer(c.accountId, c.contents)
    }
  }

  private async onReport(report: HostReport): Promise<void> {
    switch (report.type) {
      case 'needToken':
        try {
          this.send({ type: 'token', reqId: report.reqId, token: await this.handlers.token(report.accountId) })
        } catch (e) {
          this.send({ type: 'token', reqId: report.reqId, error: e instanceof Error ? e.message : String(e) })
        }
        break
      case 'badge':
        this.handlers.badge(report.accountId, report.unread)
        break
      case 'newMail':
        this.handlers.newMail(report.accountId, report.threads)
        break
      case 'ready':
        this.restarts = 0
        break
    }
  }

  addAccount(account: Account): void {
    this.accounts.push(account)
    this.send({ type: 'addAccount', account })
  }

  removeAccount(accountId: string): void {
    this.accounts = this.accounts.filter(a => a.id !== accountId)
    this.send({ type: 'removeAccount', accountId })
  }

  // Creates a channel; one end goes to the sync process, the other to the tab.
  connect(accountId: string, contents: WebContents): void {
    const entry = { accountId, contents }
    this.connections.add(entry)
    contents.once('destroyed', () => this.connections.delete(entry))
    // A reload asks for a new port, so drop the old registration.
    contents.once('did-navigate', () => this.connections.delete(entry))
    this.transfer(accountId, contents)
  }

  private transfer(accountId: string, contents: WebContents): void {
    const { port1, port2 } = new MessageChannelMain()
    this.send({ type: 'connect', accountId }, [port1])
    contents.postMessage('kestrel:port', null, [port2])
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = null
    child?.kill()
    const sorter = this.sorter
    this.sorter = null
    sorter?.kill()
  }
}
