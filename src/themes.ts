//! Theme files: `~/.config/envy/themes/<name>.md`.
//!
//! A theme file is the same shape as config.md — one ```toml fence, with a
//! markdown body that is a sample note, so opening the file in Envy previews
//! the theme it describes. Every colour in the fence is optional: what a file
//! sets *overlays* a base face (the Omarchy-derived palette in Omarchy mode,
//! otherwise Envious dark or light), which is what makes "the tokyo-night
//! palette but with my own link colour" a three-line file.
//!
//! This module owns the list of files, the overlay, the legibility check on
//! the result, and the round trip between a resolved theme and the text of a
//! file. It deliberately knows nothing about `EnvyTheme` beyond it being a
//! record of CSS colour strings — that keeps it free of a circular import with
//! theme.ts, which is the thing that applies what this resolves.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { contrastRatio, toHex, type Rgb } from './contrast'
import { schema } from './config'

/// One parsed file, exactly as Rust reports it.
export interface ThemeFileDto {
  name: string
  path: string
  mode: 'dark' | 'light' | null
  tokens: Record<string, string>
  problems: string[]
}

/// The file-stem rule, shared by the export prompt and `theme_write_text`.
export const THEME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/// `appearance.theme` spends these four words on the built-in faces, so a file
/// with one of these names can never be selected by name. It is still listed,
/// greyed, rather than hidden: a file that silently does nothing is a worse
/// puzzle than one that says why.
export const RESERVED_THEME_NAMES = ['omarchy', 'system', 'dark', 'light']

/// Which `EnvyTheme` field each toml key feeds, from the schema — so a token
/// added there needs no edit here.
const TOKEN_TO_ROLE = new Map<string, string>(
  schema.theme_tokens.colors.map((c) => [c.key, c.envy ?? c.key]),
)
const ROLE_TO_TOKEN = new Map<string, string>(
  [...TOKEN_TO_ROLE].map(([token, role]) => [role, token]),
)

/// The roles that carry text, and so have to stay readable on the two surfaces
/// notes are drawn on. Same split, and the same floors, as the Omarchy import
/// in theme.ts: body text at WCAG AA, syntax markers only ever have to be
/// visible.
const TEXT_ROLES = [
  'text',
  'link',
  'due',
  'dueSoon',
  'dueOverdue',
  'tag',
  'flag',
  'blockquote',
  'completedTask',
  'footnote',
  'highlightText',
]
const TEXT_CONTRAST = 4.5
const MARKER_CONTRAST = 2.4

// --- The file list -----------------------------------------------------------

let files: ThemeFileDto[] = []
let dir = '~/.config/envy/themes'
let started: Promise<void> | null = null

/// Loads the theme files and follows the folder. Like `initConfig`, safe to
/// call from anywhere and any number of times; `onChanged` runs whenever the
/// folder does, so the caller can re-apply the theme.
export function initThemes(onChanged: () => void): Promise<void> {
  started ??= start(onChanged)
  return started
}

async function start(onChanged: () => void) {
  try {
    files = await invoke<ThemeFileDto[]>('themes_list')
  } catch (err) {
    // An older backend, or a plain browser. The built-in faces still work.
    console.warn('theme files are not available', err)
    return
  }
  reportProblems()
  try {
    dir = (await invoke<{ themes_dir: string }>('envy_paths')).themes_dir
  } catch {
    // Only used for the "open the folder" hint; the default text is fine.
  }
  try {
    await listen<ThemeFileDto[]>('themes-changed', (event) => {
      files = event.payload
      reportProblems()
      onChanged()
    })
  } catch {
    // Outside Tauri.
  }
}

function reportProblems() {
  for (const file of files) {
    if (file.problems.length > 0) console.warn(`${file.name}.md:`, ...file.problems)
  }
}

export function themeFiles(): ThemeFileDto[] {
  return files
}

export function themeFile(name: string): ThemeFileDto | null {
  return files.find((f) => f.name === name) ?? null
}

export function themesDir(): string {
  return dir
}

// --- Colour arithmetic -------------------------------------------------------

/// `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` and `rgba(…)` as numbers. The
/// resolved theme mixes all of these — the Envious faces are written as
/// `rgba()`, Omarchy hands us hex, and a theme file can use either — so
/// anything that measures or exports a colour has to read them all.
export function cssToRgb(color: string): (Rgb & { a: number }) | null {
  const raw = color.trim()
  const fn = /^rgba?\(([^)]+)\)$/i.exec(raw)
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    return { r: parts[0], g: parts[1], b: parts[2], a }
  }
  const hex = raw.replace(/^#/, '')
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return null
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
  }
}

/// A colour as a theme file writes it: `#rrggbb`, or `#rrggbbaa` when it isn't
/// opaque. Anything unparseable comes back untouched, so an exported file
/// never silently loses a value we simply didn't recognise.
export function cssToHex(color: string): string {
  const rgb = cssToRgb(color)
  if (!rgb) return color
  const base = toHex(rgb)
  if (rgb.a >= 0.999) return base
  const alpha = Math.round(rgb.a * 255).toString(16).padStart(2, '0')
  return base + alpha
}

// --- Overlay and legibility --------------------------------------------------

/// A base face with a file's tokens painted over it. Unknown tokens and
/// unparseable colours are left out rather than written into the theme, where
/// they would reach `setProperty` and quietly do nothing.
/// A theme, seen as what these functions actually need: role → CSS colour.
/// `EnvyTheme` is exactly that but with named fields, and naming it here would
/// mean importing theme.ts, which imports this.
type Roles = Record<string, string>

export function overlayTokens<T extends object>(base: T, tokens: Roles): T {
  const out: Roles = { ...(base as Roles) }
  for (const [token, value] of Object.entries(tokens)) {
    const role = TOKEN_TO_ROLE.get(token)
    // Tokens arrive as parsed toml, so a value can be any type a person can
    // type. Anything that isn't a colour we recognise is left out rather than
    // written into the theme, where `setProperty` would drop it silently.
    if (!role || !(role in base) || typeof value !== 'string') continue
    if (!cssToRgb(value)) continue
    out[role] = value
  }
  return out as T
}

/// What a theme file has to say about the text size and face, if anything.
export function metaFromTokens(tokens: Roles): {
  fontFamily?: string
  fontSize?: string
} {
  const out: { fontFamily?: string; fontSize?: string } = {}
  if (typeof tokens.font === 'string' && tokens.font.trim()) out.fontFamily = tokens.font.trim()
  if (typeof tokens.font_size === 'string' && tokens.font_size.trim()) {
    out.fontSize = tokens.font_size.trim()
  }
  return out
}

/// Names every token a file supplied that reads badly on its own background.
///
/// The colour is kept as written: unlike Omarchy's `colors.toml`, which is a
/// file we don't own and have to make the best of, a theme file is a decision
/// somebody made on purpose, and silently overruling it would make the file
/// and the screen disagree with no explanation. Saying so in the footer is the
/// honest version — the user can see the problem and fix the file.
export function legibilityNotices(theme: object, tokens: Roles): string[] {
  const roles = theme as Roles
  const surfaces = [roles.background, roles.fileListBackground]
    .map(cssToRgb)
    .filter((c): c is Rgb & { a: number } => c !== null)
  if (surfaces.length === 0) return []

  const notices: string[] = []
  for (const token of Object.keys(tokens)) {
    const role = TOKEN_TO_ROLE.get(token)
    if (!role) continue
    const floor = role === 'marker' ? MARKER_CONTRAST : TEXT_ROLES.includes(role) ? TEXT_CONTRAST : 0
    if (floor === 0) continue
    const colour = cssToRgb(roles[role] ?? '')
    if (!colour) continue
    // The highlight ink never sits on the page; it sits on the highlight.
    const against = role === 'highlightText' ? [cssToRgb(roles.highlight ?? '')].filter((c): c is Rgb & { a: number } => c !== null) : surfaces
    if (against.length === 0) continue
    const worst = Math.min(...against.map((bg) => contrastRatio(colour, bg)))
    if (worst >= floor) continue
    notices.push(`${token} reads at ${worst.toFixed(1)}:1, below ${floor}:1`)
  }
  return notices
}

// --- Reading and writing a file ----------------------------------------------

/// The colours of a resolved theme, as the toml keys a file uses. Only the
/// colours: the font follows the `appearance.font` setting, and writing the
/// resolved CSS font stack into a theme file would produce a value fontconfig
/// has never heard of.
export function tokensFromTheme(theme: object, dark: boolean): Roles {
  const tokens: Roles = { mode: dark ? 'dark' : 'light' }
  for (const [role, value] of Object.entries(theme as Roles)) {
    const token = ROLE_TO_TOKEN.get(role)
    if (token && value) tokens[token] = cssToHex(value)
  }
  return tokens
}

/// A whole theme file: the fence, and a sample note under it so the file shows
/// what it does the moment it opens in Envy. Written in schema order, which is
/// grouped by what a colour is for rather than alphabetically.
export function renderThemeFile(name: string, tokens: Roles): string {
  const order = ['mode', 'font', 'font_size', ...schema.theme_tokens.colors.map((c) => c.key)]
  const lines: string[] = []
  for (const key of order) {
    const value = tokens[key]
    if (value === undefined || value === '') continue
    lines.push(`${key} = "${String(value).replace(/"/g, '')}"`)
  }
  // Anything the caller passed that the schema doesn't name still goes in,
  // last — losing a key on a round trip would be worse than an unknown one.
  for (const [key, value] of Object.entries(tokens)) {
    if (!order.includes(key) && value) lines.push(`${key} = "${String(value).replace(/"/g, '')}"`)
  }

  return `# ${name}

An Envy theme. Edit the values below; Envy picks the change up as you save.
Every colour is optional — leave one out and it comes from the base face.

\`\`\`toml
${lines.join('\n')}
\`\`\`

## Sample note

Ordinary body text, with **bold**, *italic* and \`inline code\` in it, plus a
==highlight== and a footnote marker.[^1]

- A list item
- Another one, with a [[Wiki Link]] and a #tag
- [ ] An open task
- [x] A finished one

> A blockquote, for the quieter voice.

\`\`\`
a fenced block
\`\`\`

A link to [the web](https://omarchy.org) and a due date @2030-01-01.

[^1]: The footnote itself.
`
}

export async function readThemeText(name: string): Promise<string> {
  return invoke<string>('theme_read_text', { name })
}

/// Creates or replaces a theme file. Returns the error text rather than
/// throwing, so callers can put it in front of the user.
export async function writeThemeFile(name: string, tokens: Roles): Promise<string | null> {
  if (!THEME_NAME_PATTERN.test(name)) {
    return 'A theme name is lower-case letters, digits and dashes, starting with a letter or digit.'
  }
  try {
    await invoke<ThemeFileDto>('theme_write_text', {
      name,
      content: renderThemeFile(name, tokens),
    })
    return null
  } catch (err) {
    return String(err)
  }
}
