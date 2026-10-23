// Reads the client JSON Google Cloud offers to download ("Download JSON"):
// { "installed": { "client_id": …, "client_secret": … } } for a Desktop app client.

export type CredentialsResult =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; error: string }

export function parseGoogleCredentials(text: string): CredentialsResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: "That file isn't JSON. Choose the file Google Cloud downloaded (client_secret_….json)." }
  }
  const root = json as Record<string, { client_id?: unknown; client_secret?: unknown } | undefined>
  if (root?.web) return { ok: false, error: 'That is a Web application client. Create a Desktop app client instead.' }
  const client = root?.installed
  if (typeof client?.client_id !== 'string' || typeof client?.client_secret !== 'string') {
    return { ok: false, error: "That file has no Desktop app client in it. Use Download JSON on the client's page." }
  }
  return { ok: true, clientId: client.client_id, clientSecret: client.client_secret }
}
