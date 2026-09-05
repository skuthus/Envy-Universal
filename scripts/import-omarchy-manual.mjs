#!/usr/bin/env node
// Convert the Omarchy manual (quattro branch) into an Envy Index:
// filename = title, wiki-links between chapters, images as ![[attachments]],
// tags, highlights. Never opens a note with `# ${title}`.
//
//   node scripts/import-omarchy-manual.mjs [src-manual-dir] [dest-index] [--force]
//
// Defaults: /tmp/omarchy-manual-src/manual  →  ~/Envy Omarchy Manual
//
// The destination is written fresh. If it already exists and holds anything,
// the script refuses unless --force is passed, since the destination is an
// ordinary path someone can mistype into a real Index.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const force = args.includes('--force') || args.includes('--wipe')
const positional = args.filter((a) => !a.startsWith('--'))
const srcDir = positional[0] ?? '/tmp/omarchy-manual-src/manual'
const destDir = positional[1] ?? path.join(os.homedir(), 'Envy Omarchy Manual')
const systemThemes = '/usr/share/omarchy/themes'

/// The only two trees an image reference is allowed to name. Everything the
/// manual points at either ships in the checkout or is an installed theme.
const imageRoots = [path.resolve(srcDir), path.resolve(systemThemes)]

/// A markdown image href is text we don't control, so `../` in the middle of
/// one would walk the copy out of those trees and into anything readable.
/// Resolve the whole path first, then insist it stayed inside.
function within(root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const ILLEGAL = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

function sanitizeTitle(title) {
  let s = [...title].map((c) => (ILLEGAL.has(c) || c.charCodeAt(0) < 32 ? '-' : c)).join('')
  s = s.trim().replace(/[.\s!]+$/, '').trim()
  return s || 'Untitled'
}

function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

const SECTIONS = [
  { name: 'The Basics', tags: ['#omarchy', '#manual', '#basics'], from: 2, to: 14 },
  { name: 'The Applications', tags: ['#omarchy', '#manual', '#apps'], from: 15, to: 29 },
  { name: 'Configuration', tags: ['#omarchy', '#manual', '#config'], from: 30, to: 44 },
  { name: 'FAQ & Install', tags: ['#omarchy', '#manual', '#faq'], from: 45, to: 51 },
]

const EXTRA_TAGS = {
  1: ['#welcome'],
  2: ['#install'],
  3: ['#macos', '#windows'],
  4: ['#hyprland', '#tiling'],
  5: ['#shell'],
  6: ['#theme'],
  7: ['#hotkeys'],
  8: ['#clipboard'],
  9: ['#reminders'],
  12: ['#screenshot'],
  15: ['#terminal'],
  16: ['#neovim'],
  17: ['#ai'],
  23: ['#browser'],
  26: ['#gaming'],
  30: ['#update'],
  33: ['#monitor'],
  38: ['#font'],
  43: ['#theme'],
  45: ['#troubleshooting'],
  48: ['#security'],
  50: ['#install', '#windows'],
  51: ['#install'],
}

const files = fs
  .readdirSync(srcDir)
  .filter((f) => /^\d{2}-.+\.md$/.test(f))
  .sort()

const chapters = files.map((file) => {
  const n = Number(file.slice(0, 2))
  const raw = fs.readFileSync(path.join(srcDir, file), 'utf8')
  const h1 = (raw.match(/^# (.+)$/m) || [, file])[1].trim()
  const title = sanitizeTitle(h1)
  const headings = [...raw.matchAll(/^#{2,6}\s+(.+)$/gm)].map((m) => m[1].trim())
  const headingBySlug = new Map(headings.map((h) => [slugify(h), h]))
  const section = SECTIONS.find((s) => n >= s.from && n <= s.to) ?? SECTIONS[0]
  const tags = [...new Set([...(section?.tags ?? ['#omarchy', '#manual']), ...(EXTRA_TAGS[n] ?? [])])]
  return { n, file, h1, title, raw, headings, headingBySlug, section, tags }
})

const byFile = new Map(chapters.map((c) => [c.file, c]))
const byNum = new Map(chapters.map((c) => [c.n, c]))

function resolveChapter(href) {
  const [file, anchor] = href.split('#')
  const base = path.basename(file)
  const ch = byFile.get(base)
  if (!ch) return null
  if (!anchor) return { ch, heading: null }
  const heading = ch.headingBySlug.get(anchor) ?? null
  return { ch, heading }
}

function copyImage(absSrc, destName) {
  const dest = path.join(destDir, 'Attachments', destName)
  if (!fs.existsSync(absSrc)) return null
  fs.copyFileSync(absSrc, dest)
  return destName
}

function importImage(href, alt) {
  const clean = href.split('?')[0]
  if (clean.startsWith('images/')) {
    const abs = path.resolve(srcDir, clean)
    if (!within(imageRoots[0], abs)) {
      console.warn(`Skipping ${href}: resolves outside ${srcDir}.`)
      return null
    }
    const name = path.basename(clean)
    return copyImage(abs, name) ? { name, alt } : null
  }
  if (clean.startsWith('../themes/')) {
    const parts = clean.split('/')
    // `../themes/<theme>/<file>` and nothing deeper or shallower.
    if (parts.length !== 4) {
      console.warn(`Skipping ${href}: not a ../themes/<theme>/<file> reference.`)
      return null
    }
    const theme = parts[2]
    const file = parts[3]
    const destName = `theme-${theme}-${file}`
    const candidates = [path.resolve(srcDir, clean), path.resolve(systemThemes, theme, file)]
    const src = candidates.find(
      (c) => imageRoots.some((root) => within(root, c)) && fs.existsSync(c),
    )
    if (!src) {
      console.warn(`Skipping ${href}: outside the manual and theme folders, or missing.`)
      return null
    }
    return copyImage(src, destName) ? { name: destName, alt: alt || theme } : null
  }
  return null
}

function wiki(ch, heading, display) {
  let target = ch.title
  if (heading) target += `#${heading}`
  if (display && display !== ch.title && display !== heading) return `[[${target}|${display}]]`
  return `[[${target}]]`
}

function convertBody(ch) {
  let text = ch.raw.replace(/\r\n/g, '\n')

  // Drop the H1 — the filename is the title.
  text = text.replace(/^# .+\n+/, '')

  // Image + following italic caption → embed with caption.
  text = text.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\n_([^_\n]+)_\n?/g,
    (_, alt, href, caption) => {
      const img = importImage(href, alt)
      if (!img) return _
      return `![[${img.name}|480|${caption}]]\n`
    },
  )

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => {
    const img = importImage(href, alt)
    if (!img) return _
    const caption = alt && alt !== path.basename(href, path.extname(href)) ? `|${alt}` : ''
    return `![[${img.name}|480${caption}]]`
  })

  // Markdown links: internal chapters become wiki-links; keep http(s).
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, label, href) => {
    if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) return all
    const resolved = resolveChapter(href)
    if (resolved) return wiki(resolved.ch, resolved.heading, label)
    return label
  })

  // Italic-only warning/emphasis paragraphs → highlights.
  text = text.replace(/^_(.+)_\s*$/gm, (all, inner) => {
    if (inner.length < 12) return all
    return `==${inner}==`
  })

  // A few Super+ chords as highlights, but not in the hotkeys table dump.
  if (ch.n !== 7) {
    const seen = new Set()
    text = text.replace(/`?(Super(?:\s*\+\s*[A-Za-z0-9]+)+)`?/g, (m) => {
      const key = m.replace(/`/g, '')
      if (seen.has(key) || seen.size >= 4) return m
      seen.add(key)
      return `==${key}==`
    })
  }

  const tagLine = ch.tags.join(' ')
  const prev = byNum.get(ch.n - 1)
  const next = byNum.get(ch.n + 1)
  const nav = [
    prev ? `← [[${prev.title}]]` : null,
    `[[Omarchy Manual]]`,
    next ? `[[${next.title}]] →` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return `${tagLine}\n\n${text.trim()}\n\n---\n${nav}\n`
}

function hubBody() {
  const lines = [
    '#omarchy #manual #index',
    '',
    'The Omarchy manual as an Envy Index. The filename is the title; chapters wiki-link to each other and to [[Welcome to Omarchy]].',
    '',
    'Source: https://omarchy.org/manual/ · https://github.com/omacom/omarchy/tree/quattro/manual',
    '',
  ]
  for (const section of SECTIONS) {
    lines.push(`## ${section.name}`)
    lines.push('')
    for (const ch of chapters.filter((c) => c.n >= section.from && c.n <= section.to)) {
      lines.push(`- [[${ch.title}]]`)
    }
    lines.push('')
  }
  lines.push('## Start here')
  lines.push('')
  lines.push('Read [[Welcome to Omarchy]], then [[Getting Started]]. Coming from another OS? See [[Coming From Mac or Windows]].')
  lines.push('')
  return lines.join('\n')
}

if (fs.existsSync(destDir)) {
  const entries = fs.readdirSync(destDir).filter((ent) => ent !== '.git')
  // Emptying the destination is the one destructive thing this script does, and
  // the destination is just an argument — so it has to be asked for out loud.
  if (entries.length && !force) {
    console.error(`Refusing: ${destDir} is not empty. Pass --force to replace its contents.`)
    process.exit(1)
  }
  for (const ent of entries) {
    fs.rmSync(path.join(destDir, ent), { recursive: true, force: true })
  }
}
fs.mkdirSync(path.join(destDir, 'Attachments'), { recursive: true })

let images = 0
for (const ch of chapters) {
  const body = convertBody(ch)
  images += (body.match(/!\[\[/g) || []).length
  fs.writeFileSync(path.join(destDir, `${ch.title}.md`), body)
}
fs.writeFileSync(path.join(destDir, 'Omarchy Manual.md'), hubBody())

const nFiles = fs.readdirSync(destDir).filter((f) => f.endsWith('.md')).length
const nAttach = fs.readdirSync(path.join(destDir, 'Attachments')).length
console.log(`Wrote ${nFiles} notes + ${nAttach} attachments into ${destDir}`)
console.log(`  ${images} image embeds, ${chapters.length} chapters + hub`)
