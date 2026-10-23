// Entry point of the sync utility process. One process serves every account;
// the main process hands it a MessagePort per tab, and each tab talks to its
// account's engine directly over that port.

import fs from 'fs'
import path from 'path'

import { AccountEngine } from './engine'
import { DemoProvider } from './providers/demo'
import { GmailProvider } from './providers/gmail'
import { PRACTICE_SEED } from './providers/practice'
import { PortSorter, SortUnavailable } from './sorter'

import type { Account, EventEnvelope, RequestEnvelope, ResponseEnvelope, TabRequest } from '../shared/types'
import type { CacheStorage, PersistedCache } from './engine'
import type { MailProvider } from './providers/provider'
import type { Sorter } from './sorter'

// Messages from the main process.
export type HostCommand =
  | { type: 'init'; dataDir: string; accounts: Account[] }
  | { type: 'addAccount'; account: Account }
  | { type: 'removeAccount'; accountId: string }
  | { type: 'connect'; accountId: string } // carries a MessagePort
  | { type: 'sorter' } // carries a MessagePort to Kestrel Sort
  | { type: 'token'; reqId: number; token?: string; error?: string }

// Messages to the main process.
export type HostReport =
  | { type: 'needToken'; reqId: number; accountId: string }
  | { type: 'badge'; accountId: string; unread: number }
  | { type: 'newMail'; accountId: string; threads: { id: string; subject: string; from: string; snippet: string }[] }
  | { type: 'ready' }

const parentPort = process.parentPort
if (!parentPort) throw new Error('sync host must run in an Electron utility process')

const engines = new Map<string, AccountEngine>()
const tokenWaiters = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
let nextTokenReq = 1
let dataDir = ''

// Every engine shares one Kestrel Sort; its port is swapped when Sort restarts.
let sortPort: PortSorter | null = null
let portWaiters: (() => void)[] = []
const sorter: Sorter = {
  async sort(items) {
    // Right after launch the port may be a moment behind; wait briefly for it.
    if (!sortPort) await new Promise<void>(resolve => (portWaiters.push(resolve), setTimeout(resolve, 10_000)))
    if (!sortPort) throw new SortUnavailable('Kestrel Sort is not running')
    return sortPort.sort(items)
  }
}

function report(r: HostReport): void {
  parentPort!.postMessage(r)
}

function cacheFile(accountId: string): string {
  return path.join(dataDir, `cache-${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

function fileStorage(accountId: string): CacheStorage {
  const file = cacheFile(accountId)
  // Saves run one at a time: two at once would race on the same temp file.
  let queue: Promise<void> = Promise.resolve()
  return {
    async load() {
      try {
        return JSON.parse(await fs.promises.readFile(file, 'utf8')) as PersistedCache
      } catch {
        return null
      }
    },
    save(cache) {
      const data = JSON.stringify(cache)
      const run = queue.then(async () => {
        const tmp = `${file}.tmp`
        await fs.promises.writeFile(tmp, data)
        await fs.promises.rename(tmp, file)
      })
      // A failed save mustn't block the ones after it; the caller still sees the error.
      queue = run.catch(() => {})
      return run
    }
  }
}

function requestToken(accountId: string): Promise<string> {
  const reqId = nextTokenReq++
  return new Promise((resolve, reject) => {
    tokenWaiters.set(reqId, { resolve, reject })
    report({ type: 'needToken', reqId, accountId })
  })
}

function providerFor(account: Account): MailProvider {
  // The tour needs a fixed inbox, so no surprise mail arrives in practice mode.
  if (account.provider === 'practice') return new DemoProvider({ name: account.name, email: account.email }, Date.now(), PRACTICE_SEED)
  if (account.provider === 'demo') {
    const demo = new DemoProvider({ name: account.name, email: account.email })
    // Lets tests act like a real server, where Done and search take a moment to answer.
    const latency = Number(process.env.KESTREL_DEMO_LATENCY_MS) || 0
    if (latency) {
      const wait = () => new Promise(r => setTimeout(r, latency))
      for (const name of ['listDoneIds', 'summaries', 'search'] as const) {
        const real = demo[name].bind(demo) as (...args: never[]) => Promise<unknown>
        Object.assign(demo, { [name]: async (...args: never[]) => (await wait(), real(...args)) })
      }
    }
    // Deliver a new message shortly after launch so push/badges are visible in demo mode.
    setTimeout(() => {
      demo.receive('maya', 'Quick question about the launch', 'Do we still want to ship split inbox rules in this release?')
      void engines.get(account.id)?.sync()
    }, 20_000)
    return demo
  }
  const unitsPerMinute = Number(process.env.KESTREL_GMAIL_UNITS_PER_MINUTE) || undefined
  const gmail = new GmailProvider(() => requestToken(account.id), fetch, {
    unitsPerMinute,
    onPause: (ms, reason) => console.error(`[gmail] ${account.id}: rate-limited, pausing ${Math.round(ms / 1000)} s (${reason})`)
  })
  // Live test runs read a real account but must never change it.
  if (process.env.KESTREL_READ_ONLY === '1') {
    const refuse = async () => {
      throw new Error('Read-only test run: nothing is sent to Gmail')
    }
    return Object.assign(gmail, { apply: refuse, send: refuse, unsubscribe: refuse })
  }
  return gmail
}

function startEngine(account: Account): void {
  if (engines.has(account.id)) return
  // The tour's practice inbox stays fixed, so it isn't sorted.
  const engine = new AccountEngine(account, providerFor(account), fileStorage(account.id), undefined, undefined, account.provider === 'practice' ? null : sorter)
  engine.on(e => {
    if (e.kind === 'badge') report({ type: 'badge', accountId: account.id, unread: e.unread })
    // Shows in the terminal that launched Kestrel. Messages carry status codes, never tokens.
    if (e.kind === 'syncState' && e.state !== 'syncing' && e.state !== 'idle') {
      console.error(`[sync] ${account.id}: ${e.state}${e.message ? ` (${e.message})` : ''}`)
    }
    if (e.kind === 'newMail') {
      report({
        type: 'newMail',
        accountId: account.id,
        threads: e.threads.map(t => ({
          id: t.id,
          subject: t.subject,
          from: `${t.returnedAt ? 'Reminder: ' : ''}${t.from.name || t.from.email}`,
          snippet: t.snippet
        }))
      })
    }
  })
  engines.set(account.id, engine)
  void engine.start()
}

async function handle(engine: AccountEngine, request: TabRequest): Promise<unknown> {
  switch (request.kind) {
    case 'listThreads':
      return engine.listThreads(request.split, request.query)
    case 'getThread':
      return engine.getThread(request.threadId)
    case 'act':
      return engine.act(request.action)
    case 'remind':
      return engine.remind(request.threadId, request.at)
    case 'unsubscribe':
      return engine.unsubscribe(request.threadId)
    case 'archiveSender':
      return engine.archiveSender(request.email)
    case 'stats':
      return engine.getStats()
    case 'labels':
      return engine.labels()
    case 'resync':
      return engine.resync()
    case 'setLabelHidden':
      return engine.setLabelHidden(request.labelId, request.hidden)
    case 'getInboxWindow':
      return engine.getInboxWindow()
    case 'setInboxWindow':
      return engine.setInboxWindow(request.window)
    case 'undo':
      return engine.undo()
    case 'send':
      return engine.scheduleSend(request.draft, request.delayMs ?? 0)
    case 'cancelSend':
      return engine.cancelSend(request.sendId)
    case 'getSplits':
      return engine.splits()
    case 'getSortState':
      return engine.getSortState()
    case 'autoLabels':
      return engine.autoLabelCounts()
    case 'setLabel':
      return engine.setLabel(request.threadId, request.label)
    case 'getAutoFile':
      return engine.getAutoFile()
    case 'getRescue':
      return engine.getRescue()
    case 'rescueScan':
      return engine.rescueScan(request.days)
    case 'bringBack':
      return engine.bringBack()
    case 'setAutoFile':
      return engine.setAutoFile(request.on)
    case 'refresh':
      return engine.sync()
  }
}

function connect(accountId: string, port: Electron.MessagePortMain): void {
  const engine = engines.get(accountId)
  if (!engine) {
    port.close()
    return
  }
  const unsubscribe = engine.on(event => port.postMessage({ event } satisfies EventEnvelope))
  port.on('message', async ({ data }) => {
    const { id, request } = data as RequestEnvelope
    let response: ResponseEnvelope
    try {
      response = { id, ok: true, result: await handle(engine, request) }
    } catch (e) {
      response = { id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    port.postMessage(response)
  })
  port.on('close', unsubscribe)
  port.start()
  // Prime the new view with current state.
  port.postMessage({ event: { kind: 'changed' } } satisfies EventEnvelope)
  port.postMessage({ event: { kind: 'badge', unread: engine.unreadCount() } } satisfies EventEnvelope)
  port.postMessage({ event: engine.lastSyncState } satisfies EventEnvelope)
}

parentPort.on('message', ({ data, ports }) => {
  const cmd = data as HostCommand
  switch (cmd.type) {
    case 'init':
      dataDir = cmd.dataDir
      fs.mkdirSync(dataDir, { recursive: true })
      cmd.accounts.forEach(startEngine)
      report({ type: 'ready' })
      break
    case 'addAccount':
      startEngine(cmd.account)
      break
    case 'removeAccount': {
      engines.get(cmd.accountId)?.stop()
      engines.delete(cmd.accountId)
      void fs.promises.rm(cacheFile(cmd.accountId), { force: true })
      break
    }
    case 'connect':
      if (ports[0]) connect(cmd.accountId, ports[0])
      break
    case 'sorter':
      if (ports[0]) {
        ports[0].start()
        sortPort = new PortSorter(ports[0])
        for (const w of portWaiters) w()
        portWaiters = []
        // A fresh Sort picks up whatever is still waiting.
        for (const e of engines.values()) void e.sortInbox()
      }
      break
    case 'token': {
      const waiter = tokenWaiters.get(cmd.reqId)
      tokenWaiters.delete(cmd.reqId)
      if (cmd.token) waiter?.resolve(cmd.token)
      else waiter?.reject(new Error(cmd.error ?? 'No token'))
      break
    }
  }
})
