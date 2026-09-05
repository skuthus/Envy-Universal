#!/usr/bin/env node
// Generates a large, realistic throwaway Index for exercising search and the
// editor: tags, task lists, due dates, wiki-links (resolved and ghost), note
// embeds, image attachments, highlights, subfolders, an Inbox, Templates and a
// pre-populated .trash. Deterministic: the same seed gives the same vault.
//
//   node scripts/gen-test-vault.mjs [dir] [count]
//
// Defaults to ~/Envy\ Test\ Vault and 5500 notes. Refuses to write into a
// directory that already holds anything at all, so it can never trample a
// real Index.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const dir = process.argv[2] ?? path.join(os.homedir(), 'Envy Test Vault')
const COUNT = Number(process.argv[3] ?? 5500)

// --- seeded RNG ---------------------------------------------------------------
let seed = 0x9e3779b9
const rand = () => {
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 0x100000000
}
const pick = (a) => a[Math.floor(rand() * a.length)]
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const chance = (p) => rand() < p
// Zipf-ish: early entries far more often than late ones.
const zipf = (a) => a[Math.min(a.length - 1, Math.floor(Math.pow(rand(), 2.2) * a.length))]

// --- vocabulary -----------------------------------------------------------------
const topics = {
  design: ['typography', 'grid', 'Bauhaus', 'kerning', 'deckle edge', 'letterpress', 'colour theory', 'whitespace', 'Swiss style', 'Helvetica', 'Garamond', 'ligature', 'baseline', 'x-height', 'print', 'poster', 'wayfinding', 'signage', 'palette', 'contrast'],
  code: ['Rust', 'borrow checker', 'async', 'CodeMirror', 'Tauri', 'WebKitGTK', 'inotify', 'regex', 'lookbehind', 'debounce', 'Hyprland', 'Wayland', 'systemd', 'cargo', 'TypeScript', 'Vite', 'D-Bus', 'XDG', 'AppImage', 'mutex'],
  reading: ['Ted Nelson', 'Xanadu', 'hypertext', 'Vannevar Bush', 'Memex', 'Engelbart', 'the map is not the territory', 'Sapir-Whorf', 'Kindle highlight', 'marginalia', 'commonplace book', 'zettelkasten', 'Luhmann', 'slip box', 'epigraph', 'footnote', 'index card', 'chapter', 'blockquote', 'annotation'],
  life: ['groceries', 'dentist', 'oil change', 'run', 'stretching', 'sleep', 'coffee', 'sourdough', 'garden', 'tomatoes', 'bike', 'laundry', 'taxes', 'insurance', 'birthday', 'dinner', 'hike', 'camping', 'passport', 'flight'],
  work: ['standup', 'roadmap', 'OKR', 'retro', 'incident', 'postmortem', 'quarterly review', 'hiring', 'interview loop', 'budget', 'vendor', 'contract', 'launch', 'release notes', 'metrics', 'dashboard', 'on-call', 'escalation', 'stakeholder', 'deck'],
  history: ['stamp mill', '1880s', 'mining camp', 'railroad', 'telegraph', 'homestead', 'ghost town', 'assay office', 'silver strike', 'boom and bust', 'frontier', 'cartography', 'survey', 'land grant', 'irrigation', 'ditch company', 'water rights', 'territory', 'statehood', 'archive'],
}
const topicNames = Object.keys(topics)
const filler = 'the a an of to in on with for and but so because while after before under over between among about across through beyond along toward against within without meanwhile eventually apparently roughly mostly barely almost nearly quite rather fairly this that these those it they we you one some any every each which what whose where when how why is are was were be been being have has had do does did will would could should might may must can'.split(' ')
const verbs = 'noticed measured drafted rewrote shipped deleted found lost compared argued skipped finished started paused resumed sketched printed folded sorted filed synced rebuilt tested broke fixed reviewed questioned assumed proved doubted remembered forgot planned cancelled booked bought sold read wrote'.split(' ')
const nouns = 'idea draft outline plan sketch list note file folder page margin edge corner surface line curve shape shadow grain texture pattern rule tool method habit routine schedule week month season year morning evening'.split(' ')

const tagPool = ['todo', 'idea', 'draft', 'project', 'reading', 'work', 'personal', 'urgent', 'someday', 'design', 'code', 'writing', 'research', 'meeting', 'journal', 'recipe', 'travel', 'health', 'finance', 'family', 'book', 'quote', 'question', 'decision', 'reference', 'archive', 'inbox', 'waiting', 'review', 'bug', 'feature', 'release', 'envy', 'linux', 'mac', 'windows', 'typography', 'history', 'mining', 'hypertext', 'kindle', 'garden', 'running', 'cooking', 'music', 'film', 'photo', 'sketch', 'letter', 'email', 'call', 'errand', 'gift', 'wishlist', 'goal', 'habit', 'metric', 'experiment', 'lesson', 'retro']

const sentence = () => {
  const t = topics[pick(topicNames)]
  const n = int(6, 16)
  const words = []
  for (let i = 0; i < n; i++) {
    const r = rand()
    words.push(r < 0.3 ? pick(t) : r < 0.5 ? pick(verbs) : r < 0.65 ? pick(nouns) : pick(filler))
  }
  let s = words.join(' ')
  s = s[0].toUpperCase() + s.slice(1)
  return s + pick(['.', '.', '.', '?', '!', ' — or not.', ', probably.'])
}
const paragraph = () => Array.from({ length: int(1, 5) }, sentence).join(' ')

// --- titles -------------------------------------------------------------------
const titleShapes = [
  () => `${cap(pick(topics[pick(topicNames)]))} ${pick(['notes', 'ideas', 'checklist', 'outline', 'questions', 'log', 'review', 'plan', 'brief', 'summary'])}`,
  () => `${cap(pick(verbs))} the ${pick(nouns)}`,
  () => `${cap(pick(topics.reading))}`,
  () => `${cap(pick(topics.history))} ${pick(['1881', '1883', '1887', '1892', 'map', 'ledger', 'letter', 'photo'])}`,
  () => `Meeting ${pick(['with', 'about', 're'])} ${cap(pick(topics.work))} ${int(1, 12)}-${int(1, 28)}-2${int(4, 6)}`,
  () => `${cap(pick(topics.life))} ${pick(['this week', 'plan', 'notes', 'list'])}`,
  () => `How to ${pick(verbs)} a ${pick(nouns)}`,
  () => `${cap(pick(topics.code))}: ${pick(['gotchas', 'setup', 'why', 'cheatsheet', 'bug', 'recipe'])}`,
  () => `${cap(pick(nouns))} ${pick(['vs', 'and', 'or'])} ${pick(nouns)}`,
  () => `Daily Note ${pick(['2024', '2025', '2026'])}-${pad(int(1, 12))}-${pad(int(1, 28))}`,
  () => `Q${int(1, 4)} ${pick(['goals', 'retro', 'budget', 'plan'])} ${pick(['2025', '2026'])}`,
  () => `${cap(pick(topics.reading))} — ${pick(['chapter', 'part', 'section'])} ${int(1, 20)}`,
  () => `"${cap(pick(nouns))}" ${pick(['(2)', 'draft', 'v2', 'final', 'FINAL final'])}`,
  () => `${cap(pick(topics.design))} & ${pick(topics.design)}`,
]
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }
function pad(n) { return String(n).padStart(2, '0') }

// Folders. Root gets most notes; nesting exercises folder: and colours.
const folders = [
  { path: '', weight: 62 },
  { path: 'Work', weight: 10 },
  { path: 'Work/Projects', weight: 5 },
  { path: 'Work/Meetings', weight: 4 },
  { path: 'Personal', weight: 6 },
  { path: 'Reading', weight: 5 },
  { path: 'Reading/Kindle', weight: 2 },
  { path: 'Journal', weight: 3 },
  { path: 'Journal/2025', weight: 2 },
  { path: 'History/Mining', weight: 1 },
]
const folderTotal = folders.reduce((a, f) => a + f.weight, 0)
const pickFolder = () => { let r = rand() * folderTotal; for (const f of folders) { r -= f.weight; if (r <= 0) return f.path } return '' }

// Allocate titles first so links can target real notes.
const used = new Set()
const notes = []
const INBOX = Math.round(COUNT * 0.03)
const TRASH = 40
for (let i = 0; i < COUNT + TRASH; i++) {
  let title
  for (let tries = 0; ; tries++) {
    title = pick(titleShapes)()
    if (tries > 3) title += ` ${int(2, 999)}`
    if (!used.has(title.toLowerCase())) break
  }
  used.add(title.toLowerCase())
  const isTrash = i >= COUNT
  const isInbox = !isTrash && i < INBOX
  notes.push({ title, folder: isInbox ? 'Inbox' : isTrash ? '.trash' : pickFolder(), trash: isTrash })
}
const liveTitles = notes.filter((n) => !n.trash).map((n) => n.title)

// --- attachments ------------------------------------------------------------
// Tiny valid PNGs, each a different solid colour, so image embeds render.
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b } }
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const images = [
  ['whiteboard.png', [240, 240, 235]], ['receipt.png', [250, 250, 250]], ['sketch-01.png', [200, 180, 150]],
  ['sketch-02.png', [150, 180, 200]], ['map-1883.png', [210, 190, 140]], ['garden-plan.png', [140, 190, 140]],
  ['screenshot 2026-08-12.png', [40, 40, 48]], ['poster draft.png', [220, 60, 60]],
]

// --- body ---------------------------------------------------------------------
const today = new Date()
const dateToken = () => {
  const r = rand()
  if (r < 0.15) return '@today'
  if (r < 0.3) return '@' + pick(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
  // Absolute dates: cluster around now, spanning overdue → months out.
  const d = new Date(today); d.setDate(d.getDate() + int(-40, 90))
  const f = rand()
  if (f < 0.5) return `@${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${String(d.getFullYear()).slice(2)}`
  if (f < 0.8) return `@${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `@${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(2)}`
}
const tag = () => '#' + zipf(tagPool)
const link = () => `[[${pick(liveTitles)}]]`
const ghost = () => `[[${cap(pick(nouns))} ${pick(['that never was', 'unwritten', 'TBD', 'stub'])}]]`
const url = () => pick(['https://envynote.app', 'https://github.com/skuthus/Envy', 'https://en.wikipedia.org/wiki/Project_Xanadu', 'https://wiki.hyprland.org', 'https://doc.rust-lang.org/book/', 'https://codemirror.net/docs/'])

function inline(s) {
  // Sprinkle markup into a sentence.
  const words = s.split(' ')
  const i = int(0, Math.max(0, words.length - 2))
  const w = words[i]
  const r = rand()
  if (r < 0.2) words[i] = `**${w}**`
  else if (r < 0.35) words[i] = `*${w}*`
  else if (r < 0.45) words[i] = `==${w} ${words[i + 1] ?? ''}==`.replace(/ ==$/, '==')
  else if (r < 0.55) words[i] = `\`${w}\``
  else if (r < 0.6) words[i] = `~~${w}~~`
  return words.join(' ')
}

function body() {
  const parts = []
  const kind = rand()
  // The filename *is* the title. Never open a note with `# Title` matching
  // the stem — that duplicates the list and fights Envy's model.
  if (chance(0.3)) parts.push(`${tag()} ${chance(0.5) ? tag() : ''}`.trim() + '\n')
  const paras = int(1, kind < 0.3 ? 2 : 6)
  for (let p = 0; p < paras; p++) {
    let text = paragraph()
    if (chance(0.5)) text = inline(text)
    if (chance(0.35)) text += ` ${link()}`
    if (chance(0.06)) text += ` ${ghost()}`
    if (chance(0.25)) text += ` ${tag()}`
    if (chance(0.12)) text += ` ${dateToken()}`
    if (chance(0.08)) text += ` ${url()}`
    parts.push(text + '\n')
    if (chance(0.15)) parts.push(`## ${cap(pick(nouns))} ${pick(['details', 'next', 'open questions', 'log', 'notes'])}\n`)
    if (chance(0.12)) parts.push(`> ${sentence()}\n`)
    if (chance(0.1)) parts.push(`- ${sentence()}\n- ${sentence()}${chance(0.5) ? ' ' + link() : ''}\n- ${sentence()}\n`)
  }
  // Task lists: about a third of notes. Mixed done/undone, some with due dates.
  if (chance(0.33)) {
    const n = int(2, 7)
    const items = []
    for (let i = 0; i < n; i++) {
      const done = chance(0.4)
      let t = `${cap(pick(verbs))} ${pick(['the', 'a'])} ${pick(nouns)}`
      if (chance(0.4)) t += ` ${dateToken()}`
      if (chance(0.2)) t += ` ${tag()}`
      if (chance(0.15)) t += ` ${link()}`
      items.push(`- [${done ? 'x' : ' '}] ${t}`)
    }
    parts.push(items.join('\n') + '\n')
  }
  if (chance(0.06)) parts.push(`![[${pick(liveTitles)}]]\n`)
  if (chance(0.05)) parts.push(`![[${pick(images)[0]}]]\n`)
  if (chance(0.05)) parts.push('```\n' + `fn ${pick(verbs)}() -> ${cap(pick(nouns))} { todo!() }` + '\n```\n')
  if (chance(0.02)) parts.push(`⎈ created\n`)
  if (chance(0.15)) parts.push(`${tag()} ${tag()} ${chance(0.3) ? tag() : ''}`.trim() + '\n')
  return parts.join('\n')
}

// --- write --------------------------------------------------------------------
// Any existing entry is enough to refuse. Checking only for .md at the top level
// missed a real Index whose notes all live in subfolders, and a vault is not the
// kind of thing to be wrong about twice.
if (fs.existsSync(dir)) {
  let entries
  try { entries = fs.readdirSync(dir) } catch (e) {
    console.error(`Refusing: cannot read ${dir} (${e.message}).`); process.exit(1)
  }
  if (entries.length) { console.error(`Refusing: ${dir} is not empty.`); process.exit(1) }
}
fs.mkdirSync(dir, { recursive: true })
for (const f of folders) if (f.path) fs.mkdirSync(path.join(dir, f.path), { recursive: true })
fs.mkdirSync(path.join(dir, 'Inbox'), { recursive: true })
fs.mkdirSync(path.join(dir, '.trash'), { recursive: true })
fs.mkdirSync(path.join(dir, 'Attachments'), { recursive: true })
fs.mkdirSync(path.join(dir, 'Templates'), { recursive: true })

for (const [name, rgb] of images) fs.writeFileSync(path.join(dir, 'Attachments', name), png(int(64, 320), int(48, 240), rgb))

const templates = {
  'Meeting Notes': 'Attendees:\n\nAgenda:\n- \n\nDecisions:\n- \n\nActions:\n- [ ] \n',
  'Daily Note': '## Today\n- [ ] \n\n## Notes\n\n#journal\n',
  'Book Notes': 'Author:\nStarted: @today\n\n## Summary\n\n## Highlights\n> \n\n#reading #book\n',
  'Project Brief': '## Goal\n\n## Scope\n\n## Risks\n\n## Milestones\n- [ ] Kickoff @friday\n\n#project\n',
  'Recipe': 'Serves:\nTime:\n\n## Ingredients\n- \n\n## Method\n1. \n\n#recipe #cooking\n',
}
for (const [t, c] of Object.entries(templates)) fs.writeFileSync(path.join(dir, 'Templates', `${t}.md`), c)

// Modified times spread over ~3 years so date: and stale: have something to bite.
const now = Date.now()
const DAY = 86400000
let written = 0
for (const note of notes) {
  const file = path.join(dir, note.folder, `${note.title.replace(/[\\/:*?"<>|]/g, '-')}.md`)
  fs.writeFileSync(file, body())
  const r = rand()
  const ageDays = r < 0.35 ? int(0, 7) : r < 0.6 ? int(8, 60) : r < 0.85 ? int(61, 365) : int(366, 1100)
  const mtime = new Date(now - ageDays * DAY - int(0, DAY))
  fs.utimesSync(file, mtime, mtime)
  written++
}

// A few notes with deliberately awkward titles.
const awkward = ['Note with #hash in title', 'Unicode – dashes — and “quotes”', 'Émigré café résumé', '日本語のノート', 'trailing space ', 'Really really really really really really really really really really long title that will not fit in the list row at all', 'Note.with.dots', '(parens) and [brackets]']
for (const t of awkward) {
  const file = path.join(dir, `${t.replace(/[\\/:*?"<>|]/g, '-').trim()}.md`)
  fs.writeFileSync(file, `${paragraph()} ${link()} ${tag()}\n`)
  written++
}

console.log(`Wrote ${written} notes into ${dir}`)
console.log(`  root + ${folders.length - 1} subfolders, Inbox (${INBOX}), .trash (${TRASH}), ${images.length} attachments, ${Object.keys(templates).length} templates`)
