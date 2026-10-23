import { shell } from 'electron'

import { APP_HOST, APP_SCHEME } from './config'

type SenderEvent = {
  sender: Electron.WebContents
  senderFrame: Electron.WebFrameMain | null
}

// Only the top-level frame of our own bundled pages may use native IPC. Email
// bodies render in iframes, so this also keeps message content away from IPC.
export function isTrustedSender(event: SenderEvent): boolean {
  const frame = event.senderFrame
  if (!frame || event.sender.isDestroyed()) return false
  try {
    if (frame !== event.sender.mainFrame) return false
    return isAppUrl(frame.url)
  } catch {
    return false
  }
}

// URL.origin is the string 'null' for custom schemes, so compare the parts.
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST
  } catch {
    return false
  }
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

// shell.openExternal on arbitrary protocols can launch local programs, so only
// hand the OS web, mail and phone links.
export function openExternalSafely(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false
  void shell.openExternal(parsed.toString())
  return true
}
