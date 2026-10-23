// Mail for the guided tour's practice inbox. The tour in the renderer refers to
// these subjects ("offsite", "board deck"), so keep the two in step.

import type { SeedThread } from './demo'

const priya = { name: 'Priya Nair', email: 'priya@northwind.io' }
const ops = { name: 'Office Ops', email: 'ops@northwind.io' }
const jordan = { name: 'Jordan Blake', email: 'jordan@fieldnotes.example' }
const leo = { name: 'Leo Okafor', email: 'leo@ventures.example' }
const maya = { name: 'Maya Chen', email: 'maya@northwind.io' }
const ana = { name: 'Ana Ruiz', email: 'ana.ruiz@example.com' }
const digest = { name: 'Field Notes', email: 'digest@fieldnotes.example' }
const builds = { name: 'Build Bot', email: 'noreply@builds.example' }

export const PRACTICE_SEED: SeedThread[] = [
  // The tour asks you to mark these three done first.
  { from: priya, subject: 'Offsite photos are up', body: 'All the photos from the team offsite are in the shared album. No action needed, just enjoy!', hoursAgo: 0.2, unread: true },
  { from: ops, subject: 'Parking passes for next month', body: 'Passes renew automatically. Nothing to do unless your plate changed.', hoursAgo: 0.5, unread: true },
  { from: jordan, subject: 'Thanks for the intro!', body: 'Had a great call with Maya. Really appreciate you connecting us.', hoursAgo: 1 },
  {
    from: leo,
    subject: 'Q3 board deck: can you take a look?',
    body: 'Draft of the Q3 board deck is ready. Could you look over the metrics slide before Thursday?',
    hoursAgo: 3,
    unread: true,
    replies: [{ from: maya, body: 'I can cover the hiring numbers if that helps.', hoursAgo: 2 }]
  },
  { from: ana, subject: 'Lunch on Friday?', body: 'There is a new dumpling place around the corner. Friday at 12:30?', hoursAgo: 5 },
  { from: digest, subject: 'Field Notes: five habits of fast teams', body: 'This week: why the best teams answer email in batches.', hoursAgo: 4, newsletter: true, unread: true },
  { from: builds, subject: 'Build #812 passed', body: 'All checks passed on main.', hoursAgo: 6 }
]
