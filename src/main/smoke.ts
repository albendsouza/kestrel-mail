// End-to-end smoke test: drives the demo inbox with real key events and saves
// screenshots. Run with `npm run smoke`.

import fs from 'fs'
import path from 'path'

import { app, BrowserWindow } from 'electron'

import type { AppWindow } from './window'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// token: for read-only Gmail API counts in the live suite (GET requests only).
export async function runSmoke(win: AppWindow, outDir: string, token?: (accountId: string) => Promise<string>): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true })
  const results: Record<string, unknown> = {}
  const failures: string[] = []
  const contents = () => win.activeTab!.view.webContents
  const evalJs = <T>(js: string) => contents().executeJavaScript(js) as Promise<T>
  // Chromium can refuse a capture ("UnknownVizError") right after a reload, before
  // the page has painted; a screenshot is never worth failing the run, so retry, then skip.
  const capture = async (wc: Electron.WebContents, file: string) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.writeFileSync(file, (await wc.capturePage()).toPNG())
        return
      } catch {
        await sleep(300)
      }
    }
    console.warn(`smoke: could not capture ${path.basename(file)}`)
  }
  const shot = async (name: string) => {
    await sleep(350)
    await capture(contents(), path.join(outDir, `${name}.png`))
    await capture(win.strip.webContents, path.join(outDir, `${name}.strip.png`))
  }
  const key = async (keyCode: string, modifiers: Electron.InputEvent['modifiers'] = []) => {
    contents().focus()
    contents().sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1) contents().sendInputEvent({ type: 'char', keyCode, modifiers })
    // Forms submit on the Return character, as a real keyboard sends it.
    else if (keyCode === 'Return' && !modifiers.length) contents().sendInputEvent({ type: 'char', keyCode: '\r' })
    contents().sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(250)
  }
  const rows = () => evalJs<number>('document.querySelectorAll(".thread-row").length')
  const check = (name: string, ok: boolean, detail?: unknown) => {
    results[name] = detail ?? ok
    if (!ok) failures.push(name)
  }

  const waitFor = async (js: string, ms = 5000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await evalJs<boolean>(js).catch(() => false)) return true
      await sleep(100)
    }
    return false
  }
  const title = () => evalJs<string>('document.querySelector(".tour-card h3")?.textContent ?? ""')
  const onStep = (text: string) => waitFor(`(document.querySelector(".tour-card h3")?.textContent ?? "").includes(${JSON.stringify(text)})`)
  const setInput = (selector: string, value: string) =>
    evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      Object.getOwnPropertyDescriptor(el.__proto__, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  const mod = process.platform === 'darwin' ? 'meta' : 'control'

  // Marks a thread done, finds it under Done, and moves it back to the inbox.
  const runDoneSmoke = async () => {
    await key('Escape')
    await key('g')
    await key('i')
    await waitFor('document.querySelectorAll(".thread-row").length > 0')
    const subject = await evalJs<string>('document.querySelector(".thread-row.selected .subject")?.textContent ?? ""')
    await key('e')
    await key('g')
    await key('e')
    const inDone = await waitFor(`[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === ${JSON.stringify(subject)})`)
    check('g e opens Done with the thread just marked done', inDone, subject)
    await shot('09b-done')
    await key('E', ['shift'])
    const back = await waitFor(`![...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === ${JSON.stringify(subject)})`)
    await key('g')
    await key('i')
    const inInbox = await waitFor(`[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === ${JSON.stringify(subject)})`)
    check('shift+e in Done moves the thread back to the inbox', back && inInbox, subject)

    // Done answers slowly here (KESTREL_DEMO_LATENCY_MS). Leaving before it answers must
    // not let its late list replace the inbox.
    // Wait out the 15 s reuse window so Done goes back to the (slow) server.
    await sleep(16_000)
    const inboxCount = await rows()
    await key('e')
    await key('g')
    await key('e')
    const loading = await evalJs<boolean>('(document.querySelector(".inbox-zero")?.textContent ?? "").includes("Loading Done")')
    check('Done shows a loading state, not the previous list', loading && (await rows()) === 0, await rows())
    await key('g')
    await key('i')
    await sleep(1800)
    check('a late Done answer does not replace the inbox', (await rows()) === inboxCount - 1, { inboxCount, now: await rows() })
    await key('z')
  }

  // Opens the setup guide window, captures every step, and saves a placeholder client through it.
  const runGuideSmoke = async () => {
    await evalJs('document.querySelector(".guide-button").click()')
    let guide: BrowserWindow | undefined
    for (let i = 0; i < 40 && !guide; i++) {
      guide = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/guide.html'))
      if (!guide) await sleep(100)
    }
    check('guide button opens the setup guide window', !!guide && guide.isAlwaysOnTop(), guide?.getTitle())
    if (!guide) return
    const g = guide.webContents
    const gjs = <T>(js: string) => g.executeJavaScript(js) as Promise<T>
    for (let i = 0; i < 40 && !(await gjs<boolean>('!!document.querySelector(".guide h1")').catch(() => false)); i++) await sleep(100)
    const titles: string[] = []
    for (let step = 0; step < 10; step++) {
      await sleep(300)
      titles.push(await gjs<string>('document.querySelector(".guide-main h1")?.textContent ?? ""'))
      fs.writeFileSync(path.join(outDir, `17-guide-step-${step}.png`), (await g.capturePage()).toPNG())
      const more = await gjs<boolean>('(() => { const b = [...document.querySelectorAll(".guide-foot .primary")].at(0); if (!b) return false; b.click(); return true })()')
      if (!more) break
    }
    check('guide walks through every step to the client form', titles.length === 7 && (await gjs<boolean>('!!document.querySelector(".guide .client-setup")')), titles)
    const links = await gjs<number>('document.querySelectorAll(".open-link").length')
    check('last step has the form, not a link', links === 0, links)
    const fill = (selector: string, value: string) =>
      gjs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.__proto__, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await fill('.client-setup input:not([type])', '000000-smoketest.apps.googleusercontent.com')
    await fill('.client-setup input[type=password]', 'placeholder-secret-123')
    await gjs('document.querySelector(".client-setup button[type=submit]").click()')
    await sleep(500)
    check('saving in the guide shows the finish screen', await gjs<boolean>('!!document.querySelector(".done-screen")'))
    fs.writeFileSync(path.join(outDir, '18-guide-done.png'), (await g.capturePage()).toPNG())
    await gjs('document.querySelector(".done-screen .primary").click()')
    await sleep(500)
    check('finishing closes the guide', guide.isDestroyed())
    await sleep(800)
  }

  const subjects = () => evalJs<string[]>('[...document.querySelectorAll(".thread-row .subject")].map(s => s.textContent)')

  // Sets a reminder with H and a typed time, finds it under g h, and sends it back with Shift+E.
  const runRemindersSmoke = async () => {
    await key('g')
    await key('i')
    await waitFor('!(document.querySelector(".sort-note")?.textContent ?? "").includes("Sorting")', 30_000)
    // The new list (and its cursor) arrives a moment after the split changes.
    await waitFor('(document.querySelector(".split.active")?.textContent ?? "").startsWith("Important") && !!document.querySelector(".thread-row.selected")')
    const subject = await evalJs<string>('document.querySelector(".thread-row.selected .subject")?.textContent ?? ""')
    await key('h')
    check(
      'h opens the reminder picker with presets',
      await waitFor('document.querySelectorAll(".palette.remind li").length >= 3'),
      await evalJs('({ rows: document.querySelectorAll(".thread-row").length, selected: document.querySelector(".thread-row.selected .subject")?.textContent ?? null, split: document.querySelector(".split.active")?.textContent, overlays: [...document.querySelectorAll(".palette, .composer, .help, .thread-view")].map(e => e.className) })')
    )
    await setInput('.palette.remind input', 'fri 3pm')
    const preview = await evalJs<string>('document.querySelector(".palette.remind li")?.textContent ?? ""')
    check('typed time is understood', /3:00/.test(preview), preview)
    await shot('19-remind-picker')
    await key('Return')
    check('setting a reminder takes the thread out of the inbox', await waitFor(`!${JSON.stringify(subject)}.length || !${'[...document.querySelectorAll(".thread-row .subject")].map(s => s.textContent)'}.includes(${JSON.stringify(subject)})`), subject)
    const toasts = await evalJs<number>('document.querySelectorAll(".toast").length')
    check('only one action toast shows at a time', toasts <= 2, toasts)
    // The picker must be gone first, or "g h" lands in its text box.
    await waitFor('!document.querySelector(".palette.remind")')
    await key('g')
    await key('h')
    const listed = await waitFor(`[...document.querySelectorAll(".thread-row")].some(r => r.querySelector(".subject")?.textContent === ${JSON.stringify(subject)} && /3:00/.test(r.querySelector(".remind-at")?.textContent ?? ""))`)
    check('g h lists the reminder with its time', listed, await subjects())
    await shot('20-reminders')
    await key('E', ['shift'])
    await key('g')
    await key('i')
    check('shift+e in Reminders brings it back now', await waitFor(`[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === ${JSON.stringify(subject)})`), await subjects())
  }

  // Senders, unsubscribe, Reply Zero and stats (ideas from Inbox Zero).
  const runInsightsSmoke = async () => {
    const toast = () => evalJs<string>('[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")')
    const activeSplit = () => evalJs<string>('document.querySelector(".split.active")?.textContent ?? ""')

    await key('g')
    await key('u')
    const senders = () => evalJs<string[]>('[...document.querySelectorAll(".thread-row .from")].map(s => s.textContent)')
    check('g u lists senders with counts', await waitFor('[...document.querySelectorAll(".thread-row .subject")].some(s => /^\\d+ conversations?$/.test(s.textContent))'), await senders())
    await shot('22-senders')
    // Find The Weekly Byte, a newsletter, and unsubscribe from it.
    const byteIndex = (await senders()).findIndex(t => t === 'The Weekly Byte')
    for (let i = 0; i < byteIndex; i++) await key('j')
    await key('u', [mod])
    check('cmd+u unsubscribes and clears the sender', await waitFor('[...document.querySelectorAll(".toast")].some(t => /Unsubscribed from The Weekly Byte, and 2 marked done/.test(t.textContent))'), await toast())
    check('the sender is gone from Senders', await waitFor('![...document.querySelectorAll(".thread-row .from")].some(s => s.textContent === "The Weekly Byte")'), await senders())
    await key('Return')
    check('enter on a sender searches their mail', await waitFor('(document.querySelector(".split.active")?.textContent ?? "").includes("from:")'), await activeSplit())
    await key('Escape')

    await key('g')
    await key('i')
    const tabs = await evalJs<string[]>('[...document.querySelectorAll(".split")].map(s => s.textContent?.replace(/\\d+$/, ""))')
    await evalJs('[...document.querySelectorAll(".split")].find(s => s.textContent.startsWith("Calendar")).click()')
    check('invitations get their own Calendar split', await waitFor('[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent.startsWith("Invitation: Roadmap review"))'), await subjects())
    check('the inbox has the Superhuman-style splits', tabs.join() === 'Important,To reply,Calendar,Codes,Updates,Other', tabs)
    await evalJs('[...document.querySelectorAll(".split")].find(s => s.textContent.startsWith("Other")).click()')
    check(
      'Laya labels the cold pitch Pitch and keeps it out of Important',
      await waitFor('[...document.querySelectorAll(".thread-row")].some(r => r.querySelector(".subject")?.textContent === "Quick question about your pipeline" && r.textContent.includes("Pitch"))'),
      await evalJs('[...document.querySelectorAll(".thread-row")].map(r => r.querySelector(".subject")?.textContent + " | " + [...r.querySelectorAll(".tag.auto")].map(t => t.textContent).join())')
    )

    // Done's three kinds, and the rescue of unread mail from people.
    await key('g')
    await key('e')
    check('Done has tabs for yours, never opened and filed away', await waitFor('[...document.querySelectorAll(".splits .split")].map(s => s.textContent).join().startsWith("Done,Never opened,Skipped inbox")'), await evalJs('[...document.querySelectorAll(".splits .split")].map(s => s.textContent)'))
    await evalJs('[...document.querySelectorAll(".splits .split")].find(s => s.textContent === "Never opened").click()')
    check('Never opened offers to find mail from people', await waitFor('(document.querySelector(".file-banner")?.textContent ?? "").includes("Find mail from people")'))
    await shot('25-never-opened')
    await key('g')
    await key('i')

    check('the sidebar lists Laya\'s labels', await waitFor('[...document.querySelectorAll(".side-heading")].some(h => h.textContent.startsWith("Auto labels"))'))
    await evalJs('[...document.querySelectorAll(".side-item")].find(b => b.querySelector(".side-name")?.textContent === "Pitch")?.click()')
    check(
      'an auto label lists the mail Laya gave it',
      await waitFor('(document.querySelector(".split.active")?.textContent ?? "") === "Pitch" && document.querySelectorAll(".thread-row").length > 0 && [...document.querySelectorAll(".thread-row")].every(r => r.textContent.includes("Pitch"))'),
      await subjects()
    )
    await shot('24b-auto-label')
    await key('l')
    check('l opens the label picker for the sender', await waitFor('(document.querySelector(".label-picker .remind-title")?.textContent ?? "").includes("Jake Miller")'))
    await setInput('.label-picker input', 'marketing')
    await key('Return')
    check('the sender is relabelled straight away', await waitFor('[...document.querySelectorAll(".side-item")].some(b => b.querySelector(".side-name")?.textContent === "Marketing")'), await evalJs('[...document.querySelectorAll(".side-name")].map(s => s.textContent)'))

    await key('g')
    await key('r')
    check('g r lists mail waiting on your reply', await waitFor('document.querySelectorAll(".thread-row").length > 0 && (document.querySelector(".split.active")?.textContent ?? "").startsWith("To reply")'), await subjects())
    await key('g')
    await key('w')
    check('g w lists mail you are waiting on', await waitFor('[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === "Intro: Priya <> Sam")', 6000), await subjects())
    await shot('23-waiting')

    await key('g')
    await key('a')
    check('g a shows the week in stats', await waitFor('document.querySelectorAll(".stats .bar").length === 14 && document.querySelectorAll(".stat-tiles div").length === 4'), await evalJs<string>('document.querySelector(".stats")?.textContent?.slice(0, 160) ?? ""'))
    const doneToday = await evalJs<string>('document.querySelectorAll(".stat-table td")[25]?.textContent ?? ""')
    check("stats count today's mail marked done", Number(doneToday) > 0, doneToday)
    await evalJs('document.querySelectorAll(".stats svg g")[13]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))')
    await shot('24-stats')
    await key('Escape')
    await key('g')
    await key('i')
  }

  // The Gmail-style pane: folders and labels from the provider.
  const runSidebarSmoke = async () => {
    const clickSide = (name: string) => evalJs(`[...document.querySelectorAll(".side-item")].find(b => b.querySelector(".side-name")?.textContent === ${JSON.stringify(name)})?.click()`)
    check('sidebar shows Gmail labels', await waitFor('["Investments", "Meeting updates"].every(n => [...document.querySelectorAll(".side-name")].some(s => s.textContent === n))'), await evalJs<string[]>('[...document.querySelectorAll(".side-name")].map(s => s.textContent)'))
    await shot('25-sidebar')
    await clickSide('Sent')
    check('Sent lists mail you sent', await waitFor('[...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === "Intro: Priya <> Sam")', 6000), await subjects())
    await clickSide('Investments')
    check('a label shows its mail', await waitFor('(document.querySelector(".split.active")?.textContent ?? "") === "Investments" && [...document.querySelectorAll(".thread-row .subject")].some(s => s.textContent === "Term sheet draft")', 6000), await subjects())
    await evalJs('[...document.querySelectorAll(".side-label")].find(r => r.textContent.includes("Investments"))?.querySelector(".side-hide")?.click()')
    check('a label can be hidden in Kestrel', await waitFor('![...document.querySelectorAll(".side-label:not(.hidden-label) .side-name")].some(s => s.textContent === "Investments") && [...document.querySelectorAll(".side-more")].some(b => b.textContent === "1 hidden")'))
    await evalJs('[...document.querySelectorAll(".side-more")].find(b => b.textContent === "1 hidden")?.click()')
    await evalJs('document.querySelector(".hidden-label .side-hide")?.click()')
    check('a hidden label can be shown again', await waitFor('[...document.querySelectorAll(".side-label:not(.hidden-label) .side-name")].some(s => s.textContent === "Investments")'))
    await clickSide('Inbox')
    check('Inbox in the sidebar returns to the splits', await waitFor('(document.querySelector(".split.active")?.textContent ?? "").startsWith("Important")'))
    await evalJs('document.querySelector(".side-collapse").click()')
    const hidden = await waitFor('!document.querySelector(".sidebar") && !!document.querySelector(".side-open")')
    await evalJs('document.querySelector(".side-open")?.click()')
    check('the sidebar hides and comes back', hidden && (await waitFor('!!document.querySelector(".sidebar")')))
    await evalJs('[...document.querySelectorAll(".side-item")].find(b => b.textContent.includes("Inbox: "))?.click()')
    check('the inbox window picker opens, defaulting to 2 weeks', await waitFor('!!document.querySelector(".window-picker") && [...document.querySelectorAll(".window-option input[type=radio]")][0].checked'))
    await shot('26-inbox-window')
    await evalJs('[...document.querySelectorAll(".window-option input[type=checkbox]")][0].click()')
    await evalJs('document.querySelector(".window-picker button[type=submit]").click()')
    await evalJs('[...document.querySelectorAll(".side-item")].find(b => b.textContent.includes("Resync with Gmail"))?.click()')
    check('resync reports that Kestrel matches Gmail', await waitFor('[...document.querySelectorAll(".toast")].some(t => t.textContent.startsWith("In step with Gmail"))', 10_000), await evalJs<string>('[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")'))
    check('choosing keep unread updates the sidebar', await waitFor('[...document.querySelectorAll(".side-name")].some(s => s.textContent === "Inbox: last 2 weeks + unread")'))
  }

  // Read-only checks on your real account (npm run smoke:live). Gmail refuses every
  // change in this mode, and nothing here marks done, sends, or unsubscribes.
  const runLiveSmoke = async () => {
    const ctx = await evalJs<{ accounts: { id: string; provider: string; email: string }[] }>('window.kestrel.context()')
    const gmail = ctx.accounts.find(a => a.provider === 'gmail')
    check('live: a Gmail account is signed in', !!gmail)
    if (!gmail) return
    await evalJs(`window.kestrel.useAccount(${JSON.stringify(gmail.id)})`).catch(() => {})
    check('live: the inbox loads', await waitFor('document.querySelectorAll(".thread-row").length > 0', 30_000), await rows())
    check(
      'live: sync reaches idle without errors',
      await waitFor('(document.querySelector(".sync-dot")?.className ?? "").includes("idle") && !document.querySelector(".sync-banner")', 180_000),
      // The sync state and any error text, never mail content.
      await evalJs<string>('(document.querySelector(".sync-dot")?.className ?? "") + " | " + (document.querySelector(".sync-banner")?.getAttribute("title") ?? "")')
    )
    // Laya sorts the real inbox on first run; the split tallies below need it done.
    check('live: Laya sorts the inbox', await waitFor('!(document.querySelector(".sort-note")?.textContent ?? "").includes("Sorting")', 240_000), await evalJs('document.querySelector(".sort-note")?.textContent || "done"'))
    check('live: the sidebar shows your Gmail inbox count', await waitFor('!!document.querySelector(".side-item.inbox .side-count")', 30_000))
    // Labels arrive just after the inbox. An account can have none, which is fine.
    await waitFor('document.querySelectorAll(".side-dot").length > 0', 20_000)
    const userLabels = await evalJs<number>('document.querySelectorAll(".side-dot").length')
    results['live: your Gmail labels in the sidebar'] = userLabels
    // Their names and counts, for checking against Gmail (saved locally in out/smoke-live).
    results['live: label names'] = await evalJs<string[]>('[...document.querySelectorAll(".side-dot")].map(d => d.closest("button").textContent)')
    results['live: account'] = gmail.id.replace(/^gmail-/, '')
    // Gmail's own unread count for the inbox (from its INBOX label), to compare with Kestrel's.
    results['live: Gmail inbox unread'] = await evalJs<string>('document.querySelector(".side-item.inbox .side-count")?.textContent ?? ""')
    // Ask Gmail itself (through search) how much inbox mail is older than the 2-week window.
    const gmailSearch = async (q: string) => {
      await key('/')
      await setInput('.search-box input', q)
      await key('Return')
      await waitFor('!document.querySelector(".inbox-zero .spinner") && (document.querySelectorAll(".thread-row").length > 0 || !!document.querySelector(".inbox-zero h2"))', 60_000)
      const n = await rows()
      await key('Escape')
      return n
    }
    results['live: Gmail search in:inbox older_than:14d'] = await gmailSearch('in:inbox older_than:14d')
    results['live: Gmail search in:inbox older_than:14d newer_than:90d'] = await gmailSearch('in:inbox older_than:14d newer_than:90d')
    results['live: Gmail search older_than:14d (any folder)'] = await gmailSearch('older_than:14d')
    // KESTREL_SMOKE_DESIGN_QUERY: for one email, which backgrounds its HTML uses and whether
    // Kestrel treats it as designed. Reports the background values only, never the content.
    if (token && process.env.KESTREL_SMOKE_DESIGN_QUERY) {
      const { hasOwnDesign } = await import('../renderer/app/MessageBody')
      for (const a of ctx.accounts.filter(x => x.provider === 'gmail')) {
        const api = async (path: string) =>
          (await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${await token(a.id)}` } })).json()) as Record<string, unknown>
        const n = Number(process.env.KESTREL_SMOKE_DESIGN_COUNT) || 1
        const found = (await api(`messages?maxResults=${n}&q=${encodeURIComponent(process.env.KESTREL_SMOKE_DESIGN_QUERY)}`)).messages as { id: string }[] | undefined
        const rows: unknown[] = []
        for (const { id } of found ?? []) {
          const msg = await api(`messages/${id}?format=full`)
          type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
          const html = (function walk(p: Part): string {
            if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8')
            return (p.parts ?? []).map(walk).join('')
          })(msg.payload as Part)
          if (!html) continue
          const from = (msg.payload as Part).headers?.find(h => h.name.toLowerCase() === 'from')?.value.match(/@([^>\s]+)/)?.[1] ?? '?'
          const values = [...html.matchAll(/background(?:-color|-image)?\s*:\s*([^;"'}]+)|\bbgcolor\s*=\s*["']?([^"'\s>]+)/gi)].map(m => (m[1] ?? m[2]).trim())
          rows.push(`${hasOwnDesign(html) ? 'DESIGNED' : 'dark    '} ${from} :: ${[...new Set(values)].slice(0, 6).join(' | ')}`)
        }
        results[`live: design check (${a.email.split('@')[1]})`] = rows
      }
    }
    // How Done splits up, counted straight from Gmail (read-only GETs): archived unread
    // versus read, by age, and how much of it Superhuman labelled.
    if (token) {
      const count = async (q: string) => {
        let n = 0
        let page = ''
        do {
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(q)}&maxResults=500${page ? `&pageToken=${page}` : ''}`, {
            headers: { Authorization: `Bearer ${await token(gmail.id)}` }
          })
          const body = (await res.json()) as { threads?: unknown[]; nextPageToken?: string }
          n += body.threads?.length ?? 0
          page = body.nextPageToken ?? ''
        } while (page && n < 5000)
        return n
      }
      const done = '-in:inbox -in:trash -in:spam -in:drafts -in:chats'
      results['live: Gmail counts'] = {
        'inbox, all': await count('in:inbox'),
        'done, under 2 weeks old, unread': await count(`${done} newer_than:14d is:unread`),
        'done, under 2 weeks old, read': await count(`${done} newer_than:14d -is:unread`),
        'done, 2 weeks to 3 months, unread': await count(`${done} older_than:14d newer_than:90d is:unread`),
        'done, 2 weeks to 3 months, read': await count(`${done} older_than:14d newer_than:90d -is:unread`),
        'done, over 3 months': await count(`${done} older_than:90d`),
        'done, from Promotions or Social tabs, last 3 months': await count(`${done} newer_than:90d {category:promotions category:social}`),
        'done, with a [Superhuman] label': await count(`${done} label:superhuman-ai`)
      }
    }
    await shot('live-01-inbox')

    // How the rules sorted your mail: per split, the conversations, their auto labels,
    // and a few senders and subjects to judge by. Saved only in out/smoke-live on this Mac.
    const sorting: Record<string, { conversations: number; labels: Record<string, number>; examples: string[] }> = {}
    await key('g')
    await key('i')
    await waitFor('(document.querySelector(".splits .split.active")?.textContent ?? "").startsWith("Important")', 10_000)
    const splitNames = await evalJs<string[]>('[...document.querySelectorAll(".splits .split")].map(b => b.childNodes[0]?.textContent?.trim() ?? "")')
    for (const name of splitNames.filter(n => n && n !== 'Starred')) {
      await evalJs(`[...document.querySelectorAll(".splits .split")].find(b => b.childNodes[0]?.textContent?.trim() === ${JSON.stringify(name)})?.click()`)
      await waitFor(`(document.querySelector(".splits .split.active")?.textContent ?? "").startsWith(${JSON.stringify(name)})`, 10_000)
      await new Promise(r => setTimeout(r, 400))
      sorting[name] = await evalJs(`(() => {
        const rows = [...document.querySelectorAll(".thread-row")]
        const labels = {}
        for (const r of rows) for (const t of r.querySelectorAll(".tag.auto")) labels[t.textContent] = (labels[t.textContent] ?? 0) + 1
        const examples = rows.slice(0, 12).map(r => (r.querySelector(".from")?.textContent ?? "") + " | " + (r.querySelector(".subject")?.textContent ?? "") + " | " + [...r.querySelectorAll(".tag.auto")].map(t => t.textContent).join(", "))
        return { conversations: rows.length, labels, examples }
      })()`)
    }
    fs.writeFileSync(path.join(outDir, 'sorting.json'), JSON.stringify(sorting, null, 2))
    results['live: conversations per split'] = Object.fromEntries(Object.entries(sorting).map(([k, v]) => [k, v.conversations]))
    await evalJs(`[...document.querySelectorAll(".splits .split")][0]?.click()`)

    const open = async (name: string) => {
      await evalJs(`[...document.querySelectorAll(".side-item")].find(b => b.querySelector(".side-name")?.textContent === ${JSON.stringify(name)})?.click()`)
      // Loaded = the spinner is gone and either rows or the empty message show.
      return waitFor('!document.querySelector(".inbox-zero .spinner") && (document.querySelectorAll(".thread-row").length > 0 || !!document.querySelector(".inbox-zero h2"))', 60_000)
    }
    // First loads come from Gmail; each should take seconds, not minutes.
    for (const folder of ['Sent', 'Drafts', 'Done (archived)', 'Starred']) {
      const started = Date.now()
      const ok = await open(folder)
      check(`live: ${folder} loads`, ok, { rows: await rows(), seconds: Math.round((Date.now() - started) / 100) / 10 })
    }
    check('live: Sent has your mail', (await open('Sent')) && (await rows()) > 0, await rows())
    await shot('live-02-sent')
    // Open a conversation you sent: already read, so opening it changes nothing.
    await evalJs('document.querySelector(".thread-row")?.click()')
    await key('Return')
    check('live: a conversation opens with its messages', await waitFor('document.querySelectorAll(".thread-view .message").length > 0', 20_000))
    await key('Escape')
    if (userLabels > 0) {
      await evalJs('document.querySelector(".side-dot")?.closest("button")?.click()')
      check('live: a label loads', await waitFor('!document.querySelector(".inbox-zero .spinner") && (document.querySelectorAll(".thread-row").length > 0 || !!document.querySelector(".inbox-zero h2"))', 30_000))
    }
    await key('g')
    await key('a')
    check('live: stats open', await waitFor('document.querySelectorAll(".stats .bar").length === 14', 10_000))
    await key('Escape')
  }

  // With your Google client from kestrel.local.json, the welcome screen is ready to sign in.
  // The account menu signs out: the tab goes back to the welcome screen to sign in again.
  const runSignOutSmoke = async () => {
    await evalJs('document.querySelector(".side-account").click()')
    check('the account row opens a menu with sign out', await waitFor('[...document.querySelectorAll(".account-menu button")].some(b => b.textContent.startsWith("Sign out of"))'))
    await shot('26-account-menu')
    await evalJs('[...document.querySelectorAll(".account-menu button")].find(b => b.textContent.startsWith("Sign out of")).click()')
    check('sign out asks first', await waitFor('(document.querySelector(".signout h2")?.textContent ?? "").startsWith("Sign out of you@kestrel.demo")'))
    await evalJs('document.querySelector(".signout .primary").click()').catch(() => {})
    check('after signing out, the welcome screen offers sign-in', await waitFor('!!document.querySelector(".onboarding") && [...document.querySelectorAll(".onboarding button")].some(b => /Sign in with Google|Set up Gmail|Try the demo inbox/.test(b.textContent))', 10_000))
    await shot('27-signed-out')
  }

  const runSignInReadySmoke = async () => {
    // Switching accounts reloads the page, which can cut the call short.
    await evalJs('window.kestrel.useAccount(null)').catch(() => {})
    const ready = await waitFor('[...document.querySelectorAll(".google-button")].some(b => !b.disabled) && !document.querySelector(".client-setup")', 8000)
    check('your Google client makes Sign in with Google ready', ready)
    await shot('21-sign-in-ready')
    await evalJs('window.kestrel.useAccount("demo")').catch(() => {})
    await waitFor('document.querySelectorAll(".thread-row").length > 0', 8000)
  }

  // Walks the guided tour end to end in a fresh practice inbox.
  const runTourSmoke = async () => {
    await evalJs('window.kestrel.startTour()')
    await sleep(800)
    check('tour starts in practice inbox', await waitFor('document.querySelectorAll(".thread-row").length > 0 && !!document.querySelector(".tour-bar")'), await title())
    await shot('10-tour-welcome')
    await key('Return')
    check('tour: enter continues', await onStep('Clear out'), await title())
    await key('e')
    await key('e')
    await shot('11-tour-mark-done')
    await key('e')
    check('tour: three E presses advance', await onStep('Changed your mind'), await title())
    const held = await rows()
    await key('e')
    await sleep(300)
    check('tour: keys outside the step are held back', (await rows()) === held, { before: held, after: await rows() })
    await key('z')
    check('tour: undo advances', await onStep('Done doesn'), await title())
    await key('Return')
    await onStep('Open a conversation')
    await key('j')
    await key('Return')
    check('tour: opening a thread advances', await onStep('Leo needs'), await title())
    await key('r')
    check('tour: reply advances', await onStep('Write a line'), await title())
    await setInput('.composer textarea', 'Looks great, I will review it tonight.')
    await shot('12-tour-reply')
    await key('Return', [mod])
    check('tour: send advances', await onStep('Back to the list'), await title())
    await key('Escape')
    await onStep('pre-sorted')
    await key('Tab')
    check('tour: tab switches split', await onStep('Jump straight back'), await title())
    await key('g')
    await key('i')
    check('tour: g i returns to Important', await onStep('Find anything'), await title())
    await key('/')
    await setInput('.search-box input', 'offsite')
    await key('Return')
    check('tour: search finds marked-done mail', await onStep('There it is'), await evalJs<string>('document.querySelector(".thread-row .subject")?.textContent ?? ""'))
    await shot('13-tour-search')
    await key('Escape')
    await onStep('Every command')
    await key('k', [mod])
    await key('Escape')
    check('tour: palette step advances', await onStep('Forgot a shortcut'), await title())
    await key('?')
    await key('?')
    check('tour: help step advances', await onStep('inbox zero'), await title())
    for (let i = 0; i < 8 && (await rows()) > 0; i++) {
      await key('e')
      await sleep(250)
    }
    check('tour: inbox zero shows the finale', await waitFor('!!document.querySelector(".tour-finale")'), await rows())
    await shot('14-tour-finale')
    await key('Return')
    await sleep(800)
    check(
      'tour: finishing returns to the welcome screen',
      await waitFor('!!document.querySelector(".onboarding") && ![...document.querySelectorAll(".account-row")].some(r => r.textContent.includes("practice"))'),
      await evalJs<string>('document.querySelector(".onboarding-card")?.textContent ?? ""').catch(() => '')
    )
    await shot('15-welcome-after-tour')
    // Without a client the welcome screen asks for one; placeholder values never reach Google.
    check('welcome screen asks for a Google client when none is set', await evalJs<boolean>('!!document.querySelector(".client-setup")'))
    await setInput('.client-setup input[type=text], .client-setup input:not([type])', 'not-a-client-id')
    await setInput('.client-setup input[type=password]', 'placeholder-secret-123')
    await evalJs('document.querySelector(".client-setup button[type=submit]").click()')
    check('client setup rejects a malformed client ID', await waitFor('(document.querySelector(".client-setup .error")?.textContent ?? "").includes("client ID")'))
    await runGuideSmoke()
    check(
      'saving a client enables Sign in with Google',
      await waitFor('[...document.querySelectorAll(".google-button")].some(b => b.textContent.includes("Sign in with Google") && !b.disabled)')
    )
    await shot('16-sign-in-ready')
  }

  try {
    if (process.env.KESTREL_SMOKE_SUITES === 'live') {
      await runLiveSmoke()
    } else {
      for (let i = 0; i < 40 && (await rows().catch(() => 0)) === 0; i++) await sleep(250)
      // Laya's first sort moves threads between splits; let it settle before counting rows.
      await waitFor('!(document.querySelector(".sort-note")?.textContent ?? "").includes("Sorting")', 60_000)
      await sleep(300)
      const initial = await rows()
      check('inbox has threads', initial > 0, initial)
      await shot('01-inbox')

      await key('j')
      await key('j')
      const selected = await evalJs<string>('document.querySelector(".thread-row.selected .subject")?.textContent ?? ""')
      check('j moves selection', !!selected, selected)

      await key('Return')
      await sleep(400)
      const subject = await evalJs<string>('document.querySelector(".thread-subject")?.textContent ?? ""')
      check('enter opens thread', subject.includes(selected), subject)
      await shot('02-thread')

      await key('r')
      const replyTo = await evalJs<string>('document.querySelector(".composer input")?.value ?? ""')
      check('r opens reply composer', replyTo.length > 0, replyTo)
      await shot('03-reply')
      await key('Escape')

      await key('Escape')
      const before = await rows()
      await key('e')
      await sleep(300)
      const after = await rows()
      check('e archives', after === before - 1, { before, after })
      await shot('04-archived')

      await key('z')
      await sleep(300)
      check('z undoes archive', (await rows()) === before, await rows())

      // Laya sorts the demo inbox on this Mac; the newsletter belongs in Other.
      check('Laya sorted the inbox', !(await evalJs<string>('document.querySelector(".sort-note")?.textContent ?? ""')).includes('off'), await evalJs('document.querySelector(".sort-note")?.textContent || "done"'))
      await key('Tab')
      await sleep(300)
      const split = await evalJs<string>('document.querySelector(".split.active")?.textContent ?? ""')
      check('tab switches split', split.startsWith('To reply'), split)
      await evalJs('[...document.querySelectorAll(".splits .split")].find(s => s.textContent.startsWith("Other")).click()')
      await waitFor('(document.querySelector(".splits .split.active")?.textContent ?? "").startsWith("Other")')
      await shot('05-other-split')
      results['Other split'] = await evalJs('[...document.querySelectorAll(".thread-row")].map(r => r.querySelector(".subject")?.textContent + " | " + [...r.querySelectorAll(".tag.auto")].map(t => t.textContent).join())')

      await evalJs('[...document.querySelectorAll(".thread-row")].find(r => r.querySelector(".subject")?.textContent === "This week: local-first apps are back")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))')
      await sleep(500)
      const banner = await evalJs<string>('document.querySelector(".images-banner")?.textContent ?? ""')
      check('remote images blocked in HTML mail', banner.includes('blocked'), banner)
      const frame = await evalJs<{ scripts: number; imgSrc: string | null; sandbox: string }>(`(() => {
        const f = document.querySelector('.message-frame')
        const d = f.contentDocument
        return { scripts: d.querySelectorAll('script').length, imgSrc: d.querySelector('img')?.getAttribute('src') ?? null, sandbox: f.getAttribute('sandbox') }
      })()`)
      check('email HTML is sanitized and script-free', frame.scripts === 0 && frame.imgSrc === null && frame.sandbox === 'allow-same-origin', frame)
      await shot('05b-html-mail')
      await key('Escape')
      await key('g')
      await key('i')

      await key('k', [process.platform === 'darwin' ? 'meta' : 'control'])
      const palette = await evalJs<number>('document.querySelectorAll(".palette li").length')
      check('cmd+k opens palette', palette > 0, palette)
      await shot('06-palette')
      await key('Escape')

      await key('?')
      check('? opens help', await evalJs<boolean>('!!document.querySelector(".help")'))
      await shot('07-help')
      await key('Escape')

      await key('c')
      await evalJs(`(() => {
        const set = (el, v) => { Object.getOwnPropertyDescriptor(el.__proto__, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
        const [to, subject] = document.querySelectorAll('.composer input')
        set(to, 'leo@ventures.example'); set(subject, 'Smoke test')
        set(document.querySelector('.composer textarea'), 'Hello from the smoke test')
      })()`)
      await shot('08-compose')
      await key('Return', [process.platform === 'darwin' ? 'meta' : 'control'])
      const toast = await evalJs<string>('[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")')
      check('cmd+enter schedules send with undo', toast.includes('Sending'), toast)
      await shot('09-undo-send')

      const dot = await evalJs<string>('document.querySelector(".sync-dot")?.className ?? ""')
      check('sync indicator reaches idle', dot.includes('idle'), dot)

      await runDoneSmoke()
      await runRemindersSmoke()
      await runInsightsSmoke()
      await runSidebarSmoke()
      if (process.env.KESTREL_GOOGLE_CREDENTIALS) await runSignInReadySmoke()
      await runSignOutSmoke()
      // First-run flows (tour, setup guide, client form) only with npm run smoke:all.
      if (process.env.KESTREL_SMOKE_SUITES === 'all') await runTourSmoke()
    }
  } catch (e) {
    failures.push(`exception: ${e instanceof Error ? e.stack : String(e)}`)
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, failures }, null, 2))
  console.log(JSON.stringify({ results, failures }, null, 2))
  app.exit(failures.length ? 1 : 0)
}
