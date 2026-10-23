// The left pane: Inbox, Kestrel's own views, your Gmail folders and labels, and
// the account. Laid out like Gmail's so switching feels familiar.

import { useState } from 'react'

import type { Account, AutoLabelCount, MailLabel } from '../../shared/types'

// Splits of the inbox; any of them counts as "in the Inbox" for highlighting.
const INBOX_SPLITS = new Set(['important', 'to-reply', 'calendar', 'codes', 'updates', 'other'])
const LABELS_SHOWN = 8
const AUTO_ICONS: Record<string, string> = {
  'To respond': '↩',
  FYI: 'ⓘ',
  'Important update': '!',
  Calendar: '▦',
  Code: '#',
  Security: '⚿',
  Finance: '₹',
  Purchase: '⌂',
  Travel: '✈',
  Notification: '◌',
  Pitch: '✉',
  Marketing: '%',
  News: '¶',
  Social: '☺'
}

const read = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const write = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Storage can be unavailable; the pane still works, it just won't remember.
  }
}

function useToggle(key: string, fallback: boolean): [boolean, () => void] {
  const [on, setOn] = useState(() => read(key, fallback))
  return [
    on,
    () =>
      setOn(v => {
        write(key, !v)
        return !v
      })
  ]
}

interface Item {
  id: string
  name: string
  icon: string
  count?: number
  keys?: string
}

export function Sidebar({
  account,
  split,
  labels,
  autoLabels,
  autoFile,
  onToggleAutoFile,
  inboxUnread,
  onGo,
  onCompose,
  onStats,
  onSwitchAccount,
  onSignOut,
  onCollapse,
  onHideLabel,
  windowLabel,
  onWindow,
  onResync,
  resyncing
}: {
  account: Account
  split: string
  labels: MailLabel[]
  autoLabels: AutoLabelCount[]
  autoFile: boolean | null
  onToggleAutoFile: () => void
  inboxUnread: number
  onGo: (split: string) => void
  onCompose: () => void
  onStats: () => void
  onSwitchAccount: () => void
  onSignOut: () => void
  onCollapse: () => void
  onHideLabel: (labelId: string, hidden: boolean) => void
  windowLabel: string
  onWindow: () => void
  onResync: () => void
  resyncing: boolean
}) {
  const [moreOpen, toggleMore] = useToggle('kestrel.sidebar.more', true)
  const [labelsOpen, toggleLabels] = useToggle('kestrel.sidebar.labels', true)
  const [autoOpen, toggleAuto] = useToggle('kestrel.sidebar.auto', true)
  const [allLabels, setAllLabels] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [accountMenu, setAccountMenu] = useState(false)
  const label = (id: string) => labels.find(l => l.id === id)
  // Kestrel's own Gmail labels (Kestrel/Marketing) show under Auto labels instead.
  const sorted = labels.filter(l => !l.system && !l.name.startsWith('Kestrel/')).sort((a, b) => a.name.localeCompare(b.name))
  const userLabels = sorted.filter(l => !l.hidden)
  const hiddenLabels = sorted.filter(l => l.hidden)
  const shownLabels = allLabels ? userLabels : userLabels.slice(0, LABELS_SHOWN)

  const kestrel: Item[] = [
    { id: 'waiting', name: 'Waiting', icon: '◷', keys: 'G W' },
    { id: 'reminders', name: 'Reminders', icon: '◔', keys: 'G H' },
    { id: 'senders', name: 'Senders', icon: '☰', keys: 'G U' }
  ]
  const gmail: Item[] = [
    { id: 'drafts', name: 'Drafts', icon: '✎', count: label('DRAFT')?.total, keys: 'G D' },
    { id: 'sent', name: 'Sent', icon: '➤', keys: 'G T' },
    { id: 'done', name: 'Done (archived)', icon: '✓', keys: 'G E' },
    { id: 'all-starred', name: 'Starred', icon: '★' },
    { id: 'spam', name: 'Spam', icon: '⊘', count: label('SPAM')?.unread },
    { id: 'trash', name: 'Trash', icon: '⌫' }
  ]

  const row = (item: Item) => (
    <button
      key={item.id}
      className={`side-item ${split === item.id ? 'active' : ''}`}
      onClick={() => onGo(item.id)}
      title={item.keys ? `${item.name} (${item.keys.replace(' ', ' then ')})` : item.name}
    >
      <span className="side-icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="side-name">{item.name}</span>
      {!!item.count && <span className="side-count">{item.count}</span>}
    </button>
  )

  return (
    <aside className="sidebar" aria-label="Folders and labels">
      <div className="side-top">
        <button className="side-compose" onClick={onCompose}>
          ✎ Compose <kbd>C</kbd>
        </button>
        <button className="ghost side-collapse" onClick={onCollapse} title="Hide the sidebar" aria-label="Hide the sidebar">
          ⇤
        </button>
      </div>

      <nav className="side-scroll">
        <button className={`side-item inbox ${INBOX_SPLITS.has(split) ? 'active' : ''}`} onClick={() => onGo('important')} title="Inbox (G then I)">
          <span className="side-icon" aria-hidden="true">
            ▤
          </span>
          <span className="side-name">Inbox</span>
          {inboxUnread > 0 && <span className="side-count strong">{inboxUnread}</span>}
        </button>
        {kestrel.map(row)}

        {autoLabels.length > 0 && (
          <>
            <button className="side-heading" onClick={toggleAuto} aria-expanded={autoOpen} title="Labels Laya gave your inbox mail, on this Mac">
              Auto labels <span aria-hidden="true">{autoOpen ? '▾' : '▸'}</span>
            </button>
            {autoOpen &&
              autoLabels.map(l => (
                <button
                  key={l.label}
                  className={`side-item ${split === `auto:${l.label}` ? 'active' : ''}`}
                  onClick={() => onGo(`auto:${l.label}`)}
                  title={`Inbox mail Laya labelled ${l.label}`}
                >
                  <span className="side-icon" aria-hidden="true">
                    {AUTO_ICONS[l.label] ?? '•'}
                  </span>
                  <span className="side-name">{l.label}</span>
                  <span className={`side-count ${l.unread ? '' : 'muted'}`}>{l.unread || l.total}</span>
                </button>
              ))}
          </>
        )}

        <button className="side-heading" onClick={toggleMore} aria-expanded={moreOpen}>
          Gmail <span aria-hidden="true">{moreOpen ? '▾' : '▸'}</span>
        </button>
        {moreOpen && gmail.map(row)}

        {sorted.length > 0 && (
          <>
            <button className="side-heading" onClick={toggleLabels} aria-expanded={labelsOpen}>
              Labels <span aria-hidden="true">{labelsOpen ? '▾' : '▸'}</span>
            </button>
            {labelsOpen &&
              shownLabels.map(l => (
                <div key={l.id} className="side-label">
                  <button className={`side-item ${split === `label:${l.id}` ? 'active' : ''}`} onClick={() => onGo(`label:${l.id}`)} title={l.name}>
                    <span className="side-dot" style={l.color ? { background: l.color } : undefined} aria-hidden="true" />
                    <span className="side-name">{l.name}</span>
                    {l.unread > 0 && <span className="side-count">{l.unread}</span>}
                  </button>
                  <button
                    className="side-hide"
                    onClick={() => onHideLabel(l.id, true)}
                    title={`Hide ${l.name} in Kestrel (it stays in Gmail)`}
                    aria-label={`Hide ${l.name}`}
                  >
                    Hide
                  </button>
                </div>
              ))}
            {labelsOpen && userLabels.length > LABELS_SHOWN && (
              <button className="side-more" onClick={() => setAllLabels(v => !v)}>
                {allLabels ? 'Fewer' : `${userLabels.length - LABELS_SHOWN} more`}
              </button>
            )}
            {labelsOpen && hiddenLabels.length > 0 && (
              <button className="side-more" onClick={() => setShowHidden(v => !v)} aria-expanded={showHidden}>
                {showHidden ? 'Done' : `${hiddenLabels.length} hidden`}
              </button>
            )}
            {labelsOpen &&
              showHidden &&
              hiddenLabels.map(l => (
                <div key={l.id} className="side-label hidden-label">
                  <span className="side-item" title={l.name}>
                    <span className="side-dot" style={l.color ? { background: l.color } : undefined} aria-hidden="true" />
                    <span className="side-name">{l.name}</span>
                  </span>
                  <button className="side-hide shown" onClick={() => onHideLabel(l.id, false)} aria-label={`Show ${l.name}`}>
                    Show
                  </button>
                </div>
              ))}
          </>
        )}
      </nav>

      <div className="side-bottom">
        <button
          className="side-item"
          onClick={onToggleAutoFile}
          title={autoFile ? 'Marketing is marked done and labelled Kestrel/Marketing. Click to keep it in the inbox.' : 'Click to mark marketing done and label it Kestrel/Marketing'}
        >
          <span className="side-icon" aria-hidden="true">
            %
          </span>
          <span className="side-name">Marketing: {autoFile ? 'filed away' : 'in inbox'}</span>
        </button>
        <button className="side-item" onClick={onWindow} title="Choose how far back the inbox goes">
          <span className="side-icon" aria-hidden="true">
            ◫
          </span>
          <span className="side-name">Inbox: {windowLabel}</span>
        </button>
        <button className="side-item" onClick={onResync} disabled={resyncing} title="Check labels, folders and the inbox against Gmail (G then Y)">
          <span className={`side-icon ${resyncing ? 'spinning' : ''}`} aria-hidden="true">
            ⟳
          </span>
          <span className="side-name">{resyncing ? 'Resyncing…' : 'Resync with Gmail'}</span>
        </button>
        <button className="side-item" onClick={onStats} title="Email stats (G then A)">
          <span className="side-icon" aria-hidden="true">
            ▥
          </span>
          <span className="side-name">Stats</span>
        </button>
        {accountMenu && (
          <div className="account-menu" role="menu" onMouseLeave={() => setAccountMenu(false)}>
            <button role="menuitem" onClick={() => (setAccountMenu(false), onSwitchAccount())}>
              Switch account
            </button>
            <button role="menuitem" onClick={() => (setAccountMenu(false), onSwitchAccount())}>
              Sign in to another account
            </button>
            <button role="menuitem" className="danger" onClick={() => (setAccountMenu(false), onSignOut())}>
              Sign out of {account.email}
            </button>
          </div>
        )}
        <button className="side-account" onClick={() => setAccountMenu(v => !v)} title="Account: switch, sign in or sign out" aria-haspopup="menu" aria-expanded={accountMenu}>
          <span className="avatar">{(account.name || account.email).slice(0, 1).toUpperCase()}</span>
          <span className="side-account-text">
            <strong>{account.name}</strong>
            <span className="muted">{account.email}</span>
          </span>
          <span aria-hidden="true">⇅</span>
        </button>
      </div>
    </aside>
  )
}
