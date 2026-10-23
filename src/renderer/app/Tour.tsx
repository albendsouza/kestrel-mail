// Guided tour over the practice inbox. A coach bar at the bottom gives one
// instruction at a time, lets through only the keys that step needs, and moves
// on once the mailbox reaches the state the step asks for.
// The mail it refers to lives in src/sync/providers/practice.ts.

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { displayKeys, keyName, type Command } from './keys'

export interface TourSnapshot {
  loaded: boolean
  split: string
  query: string | null
  threads: number // rows in the current list
  open: boolean
  composing: 'reply' | 'new' | null
  overlay: string | null
  searchOpen: boolean
}

export type TourEvent = { kind: 'command'; command: Command } | { kind: 'sent' }

interface Progress {
  archived: number
  undone: number
  sent: number
  paletteClosed: boolean
  helpClosed: boolean
}

interface Step {
  title: string
  body: ReactNode
  keys?: string[] // chips shown under the text, in binding syntax
  allow?: string[] // keys let through outside text fields; continue steps take Enter
  pips?: number // shows progress dots for "do this N times"
  done?: (s: TourSnapshot, p: Progress) => boolean
}

const k = (keys: string, isMac: boolean) => <kbd>{displayKeys(keys, isMac)}</kbd>

const steps = (isMac: boolean): Step[] => [
  {
    title: 'Welcome to your practice inbox',
    body: <>Nothing here is real mail. In about two minutes you’ll learn the keys that make Kestrel fast.</>
  },
  {
    title: 'Clear out what you’ve already handled',
    body: <>Mail you’ve read and don’t need to act on just gets in the way. Press {k('e', isMac)} to mark the top three done.</>,
    keys: ['e'],
    allow: ['e'],
    pips: 3,
    done: (_s, p) => p.archived >= 3
  },
  {
    title: 'Changed your mind?',
    body: <>Press {k('z', isMac)} to undo. It works for almost everything.</>,
    keys: ['z'],
    allow: ['z', 'Mod+z'],
    done: (_s, p) => p.undone >= 1
  },
  {
    title: 'Done doesn’t mean deleted',
    body: <>Marked-done mail leaves your inbox, but search still finds it. You’ll try that in a moment.</>
  },
  {
    title: 'Open a conversation',
    body: <>Move with {k('j', isMac)} and {k('k', isMac)}. Go down to the board deck email and press {k('Enter', isMac)} to open it.</>,
    keys: ['j', 'k', 'Enter'],
    allow: ['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter', 'o'],
    done: s => s.open
  },
  {
    title: 'Leo needs an answer',
    body: <>Press {k('r', isMac)} to reply.</>,
    keys: ['r'],
    allow: ['r', 'a', 'j', 'k', 'Escape', 'Enter'],
    done: s => s.composing === 'reply'
  },
  {
    title: 'Write a line and send it',
    body: (
      <>
        Type anything, then press {k('Mod+Enter', isMac)}. Every send waits 10 seconds, so you can still take it back. Closed it by accident?
        Press {k('r', isMac)} again.
      </>
    ),
    keys: ['Mod+Enter'],
    allow: ['r'],
    done: (_s, p) => p.sent >= 1
  },
  {
    title: 'Back to the list',
    body: <>Press {k('Escape', isMac)} to leave the conversation.</>,
    keys: ['Escape'],
    allow: ['Escape', 'u'],
    done: s => !s.open && !s.composing
  },
  {
    title: 'Your inbox comes pre-sorted',
    body: <>Newsletters and notifications get their own splits, so Important stays important. Press {k('Tab', isMac)} to look.</>,
    keys: ['Tab'],
    allow: ['Tab', 'Shift+Tab'],
    done: s => s.split !== 'important'
  },
  {
    title: 'Jump straight back',
    body: <>Press {k('g', isMac)} then {k('i', isMac)} to go to Important from anywhere.</>,
    keys: ['g', 'i'],
    allow: ['g', 'i', 'Tab', 'Shift+Tab'],
    done: s => s.split === 'important' && s.query === null
  },
  {
    title: 'Find anything, even mail you marked done',
    body: <>Press {k('/', isMac)}, type <strong>offsite</strong> and press {k('Enter', isMac)}.</>,
    keys: ['/'],
    allow: ['/'],
    done: s => !!s.query?.toLowerCase().includes('offsite') && s.threads > 0
  },
  {
    title: 'There it is',
    body: <>Out of your inbox, but never gone. Press {k('Escape', isMac)} to clear the search.</>,
    keys: ['Escape'],
    allow: ['Escape', '/'],
    done: s => s.query === null
  },
  {
    title: 'Every command in one place',
    body: <>Press {k('Mod+k', isMac)} to open the command palette. Have a look around, then press {k('Escape', isMac)} to close it.</>,
    keys: ['Mod+k'],
    allow: ['Mod+k'],
    done: (_s, p) => p.paletteClosed
  },
  {
    title: 'Forgot a shortcut?',
    body: <>Press {k('?', isMac)} to see them all, and {k('?', isMac)} again to close.</>,
    keys: ['?'],
    allow: ['?', 'Escape'],
    done: (_s, p) => p.helpClosed
  },
  {
    title: 'Now get to inbox zero',
    body: <>Press {k('e', isMac)} on everything left in Important.</>,
    keys: ['e'],
    allow: ['e', 'j', 'k', 'ArrowDown', 'ArrowUp', 'Enter', 'o', 'Escape', 'z'],
    done: s => s.loaded && s.split === 'important' && s.query === null && !s.open && s.threads === 0
  }
]

const fresh = (): Progress => ({ archived: 0, undone: 0, sent: 0, paletteClosed: false, helpClosed: false })

export function Tour({
  snapshot,
  subscribe,
  onFinish,
  isMac
}: {
  snapshot: TourSnapshot
  subscribe: (fn: (e: TourEvent) => void) => () => void
  onFinish: () => void
  isMac: boolean
}) {
  const [all] = useState(() => steps(isMac))
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState(fresh)
  const [nudge, setNudge] = useState(0)
  const step = all[index] as Step | undefined
  const finished = index >= all.length

  const advance = () => {
    setIndex(i => i + 1)
    setProgress(fresh())
    setNudge(0)
  }

  useEffect(
    () =>
      subscribe(e => {
        if (e.kind === 'sent') setProgress(p => ({ ...p, sent: p.sent + 1 }))
        else if (e.command === 'archive') setProgress(p => ({ ...p, archived: p.archived + 1 }))
        else if (e.command === 'undo') setProgress(p => ({ ...p, undone: p.undone + 1 }))
      }),
    [subscribe]
  )

  // Overlays don't go through commands, so watch them open and close.
  const lastOverlay = useRef(snapshot.overlay)
  useEffect(() => {
    const was = lastOverlay.current
    lastOverlay.current = snapshot.overlay
    if (was === 'palette' && snapshot.overlay !== 'palette') setProgress(p => ({ ...p, paletteClosed: true }))
    if (was === 'help' && snapshot.overlay !== 'help') setProgress(p => ({ ...p, helpClosed: true }))
  }, [snapshot.overlay])

  useEffect(() => {
    if (step?.done?.(snapshot, progress)) {
      // A short pause lets the user see the result before the text changes.
      const t = setTimeout(advance, 450)
      return () => clearTimeout(t)
    }
  }, [step, snapshot, progress])

  // Runs before the mailbox's own key handler, so it can hold keys back.
  const live = useRef({ step, snapshot, finished })
  live.current = { step, snapshot, finished }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { step, snapshot, finished } = live.current
      const target = e.target as HTMLElement
      const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if (typing || snapshot.overlay === 'palette') return
      const name = keyName(e, isMac)
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return
      const hold = () => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      if (finished) {
        hold()
        if (name === 'Enter') onFinish()
        return
      }
      if (!step) return
      if (!step.done) {
        hold()
        if (name === 'Enter') advance()
        else setNudge(n => n + 1)
        return
      }
      if (!step.allow?.includes(name)) {
        hold()
        setNudge(n => n + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isMac, onFinish])

  if (finished) {
    return (
      <div className="tour-finale" role="dialog" aria-label="Tour complete">
        <div className="tour-finale-inner">
          <div className="zero-mark">✓</div>
          <h1>Inbox zero.</h1>
          <p>That’s the whole idea: deal with it, mark it done, move on.</p>
          <ul className="tour-recap">
            <li>{k('e', isMac)} mark done</li>
            <li>{k('z', isMac)} undo</li>
            <li>{k('r', isMac)} reply</li>
            <li>{k('/', isMac)} search</li>
            <li>{k('Mod+k', isMac)} every command</li>
            <li>{k('?', isMac)} all shortcuts</li>
          </ul>
          <button className="primary" autoFocus onClick={onFinish}>
            Set up my inbox <kbd>{displayKeys('Enter', isMac)}</kbd>
          </button>
        </div>
      </div>
    )
  }
  if (!step) return null

  return (
    <footer className="tour-bar" aria-live="polite">
      <div key={`${index}-${nudge}`} className={`tour-card ${nudge ? 'nudge' : ''}`}>
        <div className="tour-step muted small">
          Step {index + 1} of {all.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-keys">
          {step.done ? (
            step.pips ? (
              Array.from({ length: step.pips }, (_, i) => (
                <kbd key={i} className={i < progress.archived ? 'hit' : ''}>
                  {displayKeys(step.keys![0], isMac)}
                </kbd>
              ))
            ) : (
              step.keys?.map(key => <kbd key={key}>{displayKeys(key, isMac)}</kbd>)
            )
          ) : (
            <span className="tour-continue">
              Press <kbd>{displayKeys('Enter', isMac)}</kbd> to continue
            </span>
          )}
        </div>
      </div>
      <button className="link tour-skip" onClick={onFinish}>
        Skip tour
      </button>
    </footer>
  )
}
