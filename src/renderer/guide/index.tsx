// Step-by-step guide for creating the Google OAuth client Kestrel signs in with.
// It runs in its own always-on-top window, beside the browser where the user
// works in Google Cloud. Each step links to the exact console page and shows a
// simplified drawing of it, with the control to use highlighted. The drawings
// are not screenshots: Google changes the console often, so they show the
// shape of each page and the words to look for.

import { useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { CredentialsFileButton } from '../app/CredentialsFile'

import type { GuideApi } from '../../preload/guide'

declare global {
  interface Window {
    guide: GuideApi
  }
}

const CONSOLE = 'https://console.cloud.google.com'

// ── Drawing parts ──────────────────────────────────────────────────────────

function Screen({ path, title, children }: { path: string; title: string; children: ReactNode }) {
  return (
    <figure className="screen" aria-label={`Drawing of the ${title} page`}>
      <div className="screen-bar">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="screen-url">console.cloud.google.com{path}</span>
      </div>
      <div className="screen-head">
        <span className="screen-brand">Google Cloud</span>
        <span className="screen-project">Kestrel ▾</span>
      </div>
      <div className="screen-body">
        <div className="screen-title">{title}</div>
        {children}
      </div>
    </figure>
  )
}

// A numbered marker that matches the numbers in the step's instructions.
const Mark = ({ n }: { n: number }) => <span className="mark">{n}</span>

function Field({ label, value, mark, placeholder }: { label: string; value?: string; mark?: number; placeholder?: string }) {
  return (
    <div className={`m-field ${mark ? 'hot' : ''}`}>
      <span className="m-label">{label}</span>
      <span className={`m-input ${value ? '' : 'empty'}`}>{value ?? placeholder ?? ''}</span>
      {mark && <Mark n={mark} />}
    </div>
  )
}

function Btn({ children, mark, kind = 'primary' }: { children: ReactNode; mark?: number; kind?: 'primary' | 'plain' }) {
  return (
    <span className={`m-btn ${kind} ${mark ? 'hot' : ''}`}>
      {children}
      {mark && <Mark n={mark} />}
    </span>
  )
}

function Choice({ label, note, on, mark }: { label: string; note: string; on?: boolean; mark?: number }) {
  return (
    <div className={`m-choice ${on ? 'on' : ''} ${mark ? 'hot' : ''}`}>
      <span className="m-radio" />
      <span>
        <strong>{label}</strong>
        <span className="m-note">{note}</span>
      </span>
      {mark && <Mark n={mark} />}
    </div>
  )
}

// ── Steps ──────────────────────────────────────────────────────────────────

interface Step {
  title: string
  link?: { label: string; url: string }
  body: ReactNode
  picture?: ReactNode
  tip?: ReactNode
}

const STEPS: Step[] = [
  {
    title: 'Create your own Google sign-in',
    body: (
      <>
        <p>
          Kestrel connects to Gmail through a sign-in key that <strong>you</strong> create in Google Cloud. Your mail then goes
          only between this Mac and Google.
        </p>
        <p>It takes about 5 minutes and is free. Keep this window open: it stays on top while you work in your browser.</p>
        <ol className="overview">
          <li>Create a project</li>
          <li>Turn on the Gmail API</li>
          <li>Describe the app</li>
          <li>Add yourself as a tester</li>
          <li>Create the Desktop client</li>
          <li>Paste the ID and secret here</li>
        </ol>
      </>
    )
  },
  {
    title: 'Create a project',
    link: { label: 'Open “New project”', url: `${CONSOLE}/projectcreate` },
    body: (
      <ol>
        <li>Sign in with the Google account you will read mail with, if asked.</li>
        <li>
          <Mark n={1} /> Name the project <strong>Kestrel</strong>. Leave the rest as it is.
        </li>
        <li>
          <Mark n={2} /> Click <strong>Create</strong>, and wait for the “project created” notification.
        </li>
      </ol>
    ),
    picture: (
      <Screen path="/projectcreate" title="New project">
        <Field label="Project name" value="Kestrel" mark={1} />
        <Field label="Location" value="No organization" />
        <div className="m-row">
          <Btn mark={2}>Create</Btn>
          <Btn kind="plain">Cancel</Btn>
        </div>
      </Screen>
    ),
    tip: <>Asked to accept terms or pick a country first? That only happens once for a new Google Cloud account.</>
  },
  {
    title: 'Turn on the Gmail API',
    link: { label: 'Open the Gmail API page', url: `${CONSOLE}/apis/library/gmail.googleapis.com` },
    body: (
      <ol>
        <li>
          <Mark n={1} /> Check the project picker at the top says <strong>Kestrel</strong>. If not, click it and choose Kestrel.
        </li>
        <li>
          <Mark n={2} /> Click <strong>Enable</strong>. It turns into “Manage” when it is on.
        </li>
      </ol>
    ),
    picture: (
      <Screen path="/apis/library/gmail.googleapis.com" title="Gmail API">
        <div className="m-hot-project">
          Project: Kestrel <Mark n={1} />
        </div>
        <div className="m-card">
          <div className="m-card-icon">✉</div>
          <div>
            <strong>Gmail API</strong>
            <span className="m-note">Google Enterprise API</span>
          </div>
        </div>
        <div className="m-row">
          <Btn mark={2}>Enable</Btn>
          <Btn kind="plain">Try this API</Btn>
        </div>
      </Screen>
    )
  },
  {
    title: 'Describe the app to Google',
    link: { label: 'Open Google Auth Platform', url: `${CONSOLE}/auth/overview` },
    body: (
      <ol>
        <li>
          Click <strong>Get started</strong>.
        </li>
        <li>
          <Mark n={1} /> App name: <strong>Kestrel</strong>. User support email: your own address. Click Next.
        </li>
        <li>
          <Mark n={2} /> Audience: choose <strong>Internal</strong> if your account is a company Google Workspace and only
          your company will use Kestrel. Otherwise choose <strong>External</strong>.
        </li>
        <li>Contact email: your own address. Agree to the policy and click Create.</li>
      </ol>
    ),
    picture: (
      <Screen path="/auth/overview" title="Project configuration">
        <div className="m-steps">
          <span className="done">App information</span>
          <span className="now">Audience</span>
          <span>Contact</span>
          <span>Finish</span>
        </div>
        <Field label="App name" value="Kestrel" mark={1} />
        <Choice label="Internal" note="Only people in your organization" />
        <Choice label="External" note="Any Google account, starting with test users" on mark={2} />
      </Screen>
    ),
    tip: <>Internal skips the next step, and Google never signs you out after 7 days.</>
  },
  {
    title: 'Add yourself as a test user',
    link: { label: 'Open Audience', url: `${CONSOLE}/auth/audience` },
    body: (
      <>
        <p>
          Only for <strong>External</strong>. Chose Internal? Skip to the next step.
        </p>
        <ol>
          <li>
            <Mark n={1} /> Under <strong>Test users</strong>, click <strong>Add users</strong>.
          </li>
          <li>
            <Mark n={2} /> Enter the Gmail address you will use in Kestrel, then click <strong>Save</strong>.
          </li>
        </ol>
      </>
    ),
    picture: (
      <Screen path="/auth/audience" title="Audience">
        <div className="m-line">
          Publishing status: <strong>Testing</strong>
        </div>
        <div className="m-section">Test users</div>
        <div className="m-row">
          <Btn kind="plain" mark={1}>
            + Add users
          </Btn>
        </div>
        <Field label="Email" value="you@gmail.com" mark={2} />
      </Screen>
    ),
    tip: <>While the app is in Testing, Google asks you to sign in again every 7 days. That is normal for your own client.</>
  },
  {
    title: 'Create the Desktop client',
    link: { label: 'Open “Create client”', url: `${CONSOLE}/auth/clients/create` },
    body: (
      <ol>
        <li>
          <Mark n={1} /> Application type: choose <strong>Desktop app</strong>. Not “Web application”.
        </li>
        <li>
          <Mark n={2} /> Name: <strong>Kestrel desktop</strong>.
        </li>
        <li>
          <Mark n={3} /> Click <strong>Create</strong>.
        </li>
      </ol>
    ),
    picture: (
      <Screen path="/auth/clients/create" title="Create OAuth client ID">
        <Field label="Application type" value="Desktop app ▾" mark={1} />
        <Field label="Name" value="Kestrel desktop" mark={2} />
        <div className="m-row">
          <Btn mark={3}>Create</Btn>
        </div>
      </Screen>
    ),
    tip: <>Desktop clients need no redirect address. Kestrel handles that itself on this Mac.</>
  },
  {
    title: 'Copy the ID and secret into Kestrel',
    body: (
      <ol>
        <li>
          Google shows <strong>OAuth client created</strong> with two values.
        </li>
        <li>
          Easiest: <Mark n={3} /> click <strong>Download JSON</strong>, then <strong>Choose JSON file</strong> below and pick the downloaded{' '}
          <code>client_secret_….json</code>.
        </li>
        <li>
          Or copy <Mark n={1} /> the <strong>Client ID</strong> and <Mark n={2} /> the <strong>Client secret</strong> into the boxes
          below. Do it now: Google may show the secret only once.
        </li>
      </ol>
    ),
    picture: (
      <Screen path="/auth/clients" title="OAuth client created">
        <Field label="Client ID" value="1234-abcd….apps.googleusercontent.com  ⧉" mark={1} />
        <Field label="Client secret" value="GOCSPX-••••••••••••  ⧉" mark={2} />
        <div className="m-row">
          <Btn kind="plain" mark={3}>
            Download JSON
          </Btn>
          <Btn>OK</Btn>
        </div>
      </Screen>
    ),
    tip: (
      <>
        Closed it already? Open the client under <strong>Clients</strong>. If the secret is hidden, click{' '}
        <strong>Add secret</strong> to make a new one.
      </>
    )
  }
]

// ── Window ─────────────────────────────────────────────────────────────────

function ClientForm({ onSaved }: { onSaved: () => void }) {
  const fileButton = <CredentialsFileButton className="primary" save={window.guide.setGoogleClient} onSaved={onSaved} />
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await window.guide.setGoogleClient(clientId, secret)
      onSaved()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setError(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^\[[a-z-]+\] /, ''))
      setSaving(false)
    }
  }
  return (
    <form
      className="client-setup"
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
    >
      {fileButton}
      <p className="muted small or">or paste them</p>
      <label>
        <span>Client ID</span>
        <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
      </label>
      <label>
        <span>Client secret</span>
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <button className="secondary" type="submit" disabled={saving || !clientId.trim() || !secret.trim()}>
        Save to Kestrel
      </button>
      {error && <p className="error">{error}</p>}
      <p className="muted small">Saved on this Mac only. The secret is encrypted with your keychain.</p>
    </form>
  )
}

function Guide() {
  const [index, setIndex] = useState(0)
  const [saved, setSaved] = useState(false)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  // Arrow keys move between steps, except while typing in the form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'ArrowRight') setIndex(i => Math.min(i + 1, STEPS.length - 1))
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.querySelector('.guide-main')?.scrollTo({ top: 0 })
  }, [index])

  if (saved) {
    return (
      <div className="guide done-screen">
        <div className="zero-mark">✓</div>
        <h1>You’re set up</h1>
        <p>Kestrel has your client. Go back to Kestrel and click Sign in with Google.</p>
        <p className="muted small">
          Google will say it hasn’t verified the app. It’s your own app, so click <strong>Continue</strong>, then allow access.
        </p>
        <button className="primary" autoFocus onClick={() => void window.guide.finish()}>
          Back to Kestrel
        </button>
      </div>
    )
  }

  return (
    <div className="guide">
      <header className="guide-head">
        <div className="guide-progress" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <button key={s.title} className={`pip ${i === index ? 'now' : i < index ? 'done' : ''}`} onClick={() => setIndex(i)} title={s.title} />
          ))}
        </div>
        <span className="muted small">
          {index === 0 ? 'About 5 minutes' : `Step ${index} of ${STEPS.length - 1}`}
        </span>
      </header>
      <main className="guide-main">
        <h1 key={index}>{step.title}</h1>
        {step.link && (
          <button className="open-link" onClick={() => void window.guide.openExternal(step.link!.url)}>
            {step.link.label} in your browser ↗
          </button>
        )}
        <div className="guide-body">{step.body}</div>
        {step.picture}
        {step.tip && <p className="tip">{step.tip}</p>}
        {last && <ClientForm onSaved={() => setSaved(true)} />}
      </main>
      <footer className="guide-foot">
        <button className="ghost" disabled={index === 0} onClick={() => setIndex(i => i - 1)}>
          ← Back
        </button>
        {!last && (
          <button className="primary" onClick={() => setIndex(i => i + 1)}>
            {index === 0 ? 'Start' : 'Next'} →
          </button>
        )}
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Guide />)
