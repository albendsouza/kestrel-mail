import type { Address } from './types'

export interface MailtoFields {
  to: Address[]
  cc: Address[]
  subject: string
  body: string
}

const toAddresses = (value: string | null): Address[] =>
  (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(email => ({ name: email, email }))

export function parseMailto(url: string): MailtoFields {
  const withoutScheme = url.replace(/^mailto:/i, '')
  const [rawTo, query = ''] = withoutScheme.split('?')
  const params = new URLSearchParams(query)
  const get = (k: string) => {
    for (const [key, v] of params) if (key.toLowerCase() === k) return v
    return null
  }
  return {
    to: [...toAddresses(decodeURIComponent(rawTo)), ...toAddresses(get('to'))],
    cc: toAddresses(get('cc')),
    subject: get('subject') ?? '',
    body: get('body') ?? ''
  }
}
