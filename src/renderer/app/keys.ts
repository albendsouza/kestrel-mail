// Keyboard map. Sequences like "g i" are typed one key at a time.

export type Command =
  | 'next'
  | 'prev'
  | 'open'
  | 'back'
  | 'archive'
  | 'trash'
  | 'star'
  | 'toggleRead'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'compose'
  | 'search'
  | 'palette'
  | 'help'
  | 'undo'
  | 'nextSplit'
  | 'prevSplit'
  | 'goImportant'
  | 'goStarred'
  | 'goDone'
  | 'goReminders'
  | 'remind'
  | 'setLabel'
  | 'goSenders'
  | 'goDrafts'
  | 'resync'
  | 'goSent'
  | 'goToReply'
  | 'goWaiting'
  | 'stats'
  | 'unsubscribe'
  | 'moveToInbox'
  | 'refresh'
  | 'loadImages'

export const BINDINGS: { keys: string; command: Command; label: string }[] = [
  { keys: 'j', command: 'next', label: 'Next conversation' },
  { keys: 'ArrowDown', command: 'next', label: 'Next conversation' },
  { keys: 'k', command: 'prev', label: 'Previous conversation' },
  { keys: 'ArrowUp', command: 'prev', label: 'Previous conversation' },
  { keys: 'Enter', command: 'open', label: 'Open conversation' },
  { keys: 'o', command: 'open', label: 'Open conversation' },
  { keys: 'Escape', command: 'back', label: 'Back to list' },
  { keys: 'u', command: 'back', label: 'Back to list' },
  { keys: 'e', command: 'archive', label: 'Mark done (archive)' },
  { keys: '#', command: 'trash', label: 'Trash' },
  { keys: 's', command: 'star', label: 'Star / unstar' },
  { keys: 'U', command: 'toggleRead', label: 'Mark read / unread' },
  { keys: 'r', command: 'reply', label: 'Reply' },
  { keys: 'a', command: 'replyAll', label: 'Reply all' },
  { keys: 'f', command: 'forward', label: 'Forward' },
  { keys: 'c', command: 'compose', label: 'Compose' },
  { keys: '/', command: 'search', label: 'Search' },
  { keys: 'Mod+k', command: 'palette', label: 'Command palette' },
  { keys: '?', command: 'help', label: 'Keyboard shortcuts' },
  { keys: 'z', command: 'undo', label: 'Undo' },
  { keys: 'Mod+z', command: 'undo', label: 'Undo' },
  { keys: 'Tab', command: 'nextSplit', label: 'Next split' },
  { keys: 'Shift+Tab', command: 'prevSplit', label: 'Previous split' },
  { keys: 'g i', command: 'goImportant', label: 'Go to Important' },
  { keys: 'g s', command: 'goStarred', label: 'Go to Starred' },
  { keys: 'g e', command: 'goDone', label: 'Go to Done' },
  { keys: 'h', command: 'remind', label: 'Remind me (snooze)' },
  { keys: 'l', command: 'setLabel', label: 'Label this sender (teaches Laya)' },
  { keys: 'g h', command: 'goReminders', label: 'Go to Reminders' },
  { keys: 'g r', command: 'goToReply', label: 'Go to To reply (Reply Zero)' },
  { keys: 'g w', command: 'goWaiting', label: 'Go to Waiting (Reply Zero)' },
  { keys: 'g u', command: 'goSenders', label: 'Go to Senders (clean up)' },
  { keys: 'g d', command: 'goDrafts', label: 'Go to Drafts' },
  { keys: 'g t', command: 'goSent', label: 'Go to Sent' },
  { keys: 'Mod+u', command: 'unsubscribe', label: 'Unsubscribe and clear sender' },
  { keys: 'g a', command: 'stats', label: 'Show email stats' },
  { keys: 'g y', command: 'resync', label: 'Resync with Gmail (labels, folders, inbox)' },
  { keys: 'E', command: 'moveToInbox', label: 'Move to inbox (not done)' },
  { keys: 'R', command: 'refresh', label: 'Refresh' },
  { keys: 'i', command: 'loadImages', label: 'Load remote images' }
]

export function keyName(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, isMac: boolean): string {
  const mod = isMac ? e.metaKey : e.ctrlKey
  const printable = e.key.length === 1
  const parts: string[] = []
  if (mod) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  // For plain printable keys Shift is already in the character ("#", "?", "U").
  if (e.shiftKey && (!printable || mod || e.altKey)) parts.push('Shift')
  parts.push(printable && (mod || e.altKey) ? e.key.toLowerCase() : e.key)
  return parts.join('+')
}

// Resolves key presses into commands, tracking a pending "g" prefix.
export class KeyResolver {
  private prefix: string | null = null
  private prefixAt = 0

  constructor(private readonly now: () => number = Date.now) {}

  press(name: string): Command | null {
    const candidates = this.prefix && this.now() - this.prefixAt < 1500 ? [`${this.prefix} ${name}`, name] : [name]
    this.prefix = null
    for (const keys of candidates) {
      const b = BINDINGS.find(x => x.keys === keys)
      if (b) return b.command
    }
    if (BINDINGS.some(b => b.keys.startsWith(`${name} `))) {
      this.prefix = name
      this.prefixAt = this.now()
    }
    return null
  }
}

export function displayKeys(keys: string, isMac: boolean): string {
  return keys
    .split(' ')
    .map(chord =>
      chord
        .split('+')
        .map(k => ({ Mod: isMac ? '⌘' : 'Ctrl', Shift: '⇧', Enter: '↵', Escape: 'Esc', ArrowDown: '↓', ArrowUp: '↑' })[k] ?? k)
        .join(isMac ? '' : '+')
    )
    .join(' then ')
}
