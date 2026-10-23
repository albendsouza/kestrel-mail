// "Choose JSON file" for the client file Google Cloud downloads. The file is read
// here in the page; only the client ID and secret go on to be saved.

import { useRef, useState } from 'react'

import { parseGoogleCredentials } from '../../shared/credentials'

export function CredentialsFileButton({
  save,
  onSaved,
  className = 'secondary'
}: {
  save: (clientId: string, clientSecret: string) => Promise<unknown>
  onSaved: () => void
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const parsed = parseGoogleCredentials(await file.text())
    if (!parsed.ok) return setError(parsed.error)
    try {
      await save(parsed.clientId, parsed.clientSecret)
      onSaved()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setError(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^\[[a-z-]+\] /, ''))
    } finally {
      if (input.current) input.current.value = ''
    }
  }
  return (
    <div className="credentials-file">
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={e => void onFile(e.target.files?.[0])} />
      <button type="button" className={className} onClick={() => input.current?.click()}>
        Choose JSON file…
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
