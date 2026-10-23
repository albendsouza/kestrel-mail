// Minimal RFC 2822 helpers for building outgoing mail and parsing headers.

import type { Address, Draft } from '../shared/types'

export function parseAddress(raw: string): Address {
  const trimmed = raw.trim()
  const match = trimmed.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/)
  if (match) {
    const email = match[2].trim()
    return { name: (match[1] || '').trim() || email, email }
  }
  return { name: trimmed, email: trimmed }
}

// Splits on commas that are outside quotes and angle brackets.
export function parseAddressList(raw: string | undefined | null): Address[] {
  if (!raw) return []
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === '<') inAngle = true
    else if (ch === '>') inAngle = false
    if (ch === ',' && !inQuotes && !inAngle) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts.map(parseAddress).filter(a => a.email)
}

export function formatAddress(a: Address): string {
  if (!a.name || a.name === a.email) return a.email
  const name = stripHeaderBreaks(a.name)
  // Display names with specials must be quoted; non-ASCII ones are encoded instead.
  const display = isAscii(name) && /[",;<>@()]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderWord(name)
  return `${display} <${a.email}>`
}

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value)

// Encodes a header value as an RFC 2047 encoded-word when it is not plain ASCII.
export function encodeHeaderWord(value: string): string {
  return isAscii(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

export function buildRfc2822(draft: Draft, from: Address, now = new Date()): string {
  const headers: string[] = [
    `From: ${formatAddress(from)}`,
    `To: ${draft.to.map(formatAddress).join(', ')}`
  ]
  if (draft.cc.length) headers.push(`Cc: ${draft.cc.map(formatAddress).join(', ')}`)
  headers.push(`Subject: ${encodeHeaderWord(stripHeaderBreaks(draft.subject))}`)
  headers.push(`Date: ${now.toUTCString().replace('GMT', '+0000')}`)
  headers.push('MIME-Version: 1.0')
  headers.push('Content-Type: text/plain; charset="UTF-8"')
  headers.push('Content-Transfer-Encoding: base64')
  if (draft.replyTo?.messageIdHeader) {
    const inReplyTo = stripHeaderBreaks(draft.replyTo.messageIdHeader)
    headers.push(`In-Reply-To: ${inReplyTo}`)
    const refs = [draft.replyTo.references, inReplyTo].filter(Boolean).map(r => stripHeaderBreaks(r!))
    headers.push(`References: ${refs.join(' ')}`)
  }
  const body = Buffer.from(draft.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}
