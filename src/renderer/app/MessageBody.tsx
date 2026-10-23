// Renders one email body in a script-less sandboxed iframe. Remote images are
// held back until the user asks for them, which also blocks tracking pixels.

import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef } from 'react'

import type { Message } from '../../shared/types'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(/\bhttps?:\/\/[^\s<]+/g, url => `<a href="${url}">${url}</a>`)
  return `<div style="white-space:pre-wrap;word-wrap:break-word">${linked}</div>`
}

export function sanitizeEmailHtml(html: string, allowRemote: boolean): { html: string; blockedImages: number } {
  let blockedImages = 0
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer noopener')
    }
    if (!allowRemote && node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      if (/^https?:/i.test(src)) {
        node.removeAttribute('src')
        node.removeAttribute('srcset')
        blockedImages++
      }
    }
  })
  try {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'meta', 'link'],
      FORBID_ATTR: ['srcdoc', 'formaction', 'ping']
    })
    return { html: clean, blockedImages }
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

// Mail with a design of its own (newsletters, receipts) paints its own backgrounds and
// is written for a light page. Mail a person typed has none, even when it's HTML:
// Gmail wraps ordinary mail in HTML and its signatures hard-code near-black text.
export function hasOwnDesign(html: string): boolean {
  return /\bbgcolor\s*=|background(-color|-image)?\s*:/i.test(html)
}

export function MessageBody({
  message,
  allowRemote,
  dark,
  onBlocked,
  onLink
}: {
  message: Message
  allowRemote: boolean
  dark: boolean
  onBlocked: (count: number) => void
  onLink: (url: string) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)

  const { srcDoc, blocked } = useMemo(() => {
    const source = message.html ?? textToHtml(message.text ?? '')
    const { html, blockedImages } = sanitizeEmailHtml(source, allowRemote)
    // The iframe inherits the page CSP; this narrows it further for message content.
    const csp = `default-src 'none'; img-src data: cid:${allowRemote ? ' https:' : ''}; style-src 'unsafe-inline'; font-src data:`
    // In dark mode, everything follows the app's theme except mail with a design of its own,
    // which gets the white page it was made for.
    const designed = !!message.html && hasOwnDesign(html)
    const darkMail = dark && !designed
    // The frame's color-scheme must match the app's, or Chromium paints an opaque white backdrop behind it.
    const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{color-scheme:${darkMail ? 'dark' : 'light'}}
html,body{margin:0;padding:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:${darkMail ? '#e6e6e9' : '#1f2328'};background:${designed ? '#fff' : 'transparent'};overflow:hidden}
a{color:${darkMail ? '#8ab4ff' : '#2463eb'}}
img{max-width:100%;height:auto}
blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid ${darkMail ? '#3a3b42' : '#ccc'};color:${darkMail ? '#9a9ca5' : '#666'}}
${
  // Typed mail often hard-codes dark text (signatures, <font color>); in the dark theme it would vanish.
  darkMail && message.html ? 'body *:not(a):not(a *){color:inherit!important}blockquote,blockquote *:not(a){color:#9a9ca5!important}' : ''
}
</style></head><body>${html}</body></html>`
    return { srcDoc: doc, blocked: blockedImages }
  }, [message, allowRemote, dark])

  useEffect(() => onBlocked(blocked), [blocked, onBlocked])

  const onLoad = () => {
    const doc = frame.current?.contentDocument
    if (!doc || !frame.current) return
    // body height, not documentElement: the latter is at least the iframe's own height.
    frame.current.style.height = `${Math.ceil(doc.body.getBoundingClientRect().height) + 8}px`
    doc.addEventListener('click', e => {
      const a = (e.target as Element).closest('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href')
      if (href) onLink(href)
    })
  }

  return (
    <iframe
      ref={frame}
      className="message-frame"
      title={message.subject}
      // No allow-scripts: email content never runs code. allow-same-origin lets us size it and catch link clicks.
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={onLoad}
    />
  )
}
