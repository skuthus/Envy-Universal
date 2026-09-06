import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { contrastRatio, legible, parseHex } from './contrast'
import { getString, initConfig, onChange as onConfigChange } from './config'
import {
  cssToRgb,
  initThemes,
  legibilityNotices,
  metaFromTokens,
  overlayTokens,
  themeFile,
} from './themes'

// Envy-Linux: Envy's named color roles, filled either from the current
// Omarchy theme (`colors.toml`) or from the Envious light/dark faces kept as
// a Settings override.
//
// Roles stay the same as Theme.swift so the styler doesn't care which palette
// is driving them:
//   blue/accent   wiki-links, and the note list's selected row
//   red           the editor's text selection, and overdue
//   green         tags and ticked checkboxes
//   yellow/amber  due-soon, and search matches

export const SYSTEM_UI_FONT = "system-ui, 'Segoe UI', sans-serif"
/// The face each platform falls back to when nothing else has been chosen —
/// see `resolveFont`, which prefers an explicit custom family, then Omarchy's,
/// then this. Windows ships Cascadia Mono (Windows 11) and Consolas (back to
/// Vista), so it names one every machine actually has, and Mono — the face
/// without ligatures — is the one that reads as a plain text editor. Linux
/// gets JetBrains Mono, with the same two as backstops for a machine that has
/// not installed it.
export const MONO_FONT = /Windows/i.test(navigator.userAgent)
  ? "'Cascadia Mono', Consolas, ui-monospace, monospace"
  : "'JetBrains Mono', 'Cascadia Mono', ui-monospace, monospace"

export interface EnvyTheme {
  /// Font is part of the theme on the Mac (`Theme.fontName` / `fontSize`) and
  /// applies to both faces — unlike colors, it isn't a light/dark concern.
  fontFamily: string
  /// Face for backticks and fenced blocks. Follows the UI font when that font
  /// is already mono (the Omarchy default); otherwise a dedicated mono stack.
  monoFamily: string
  fontSize: string
  text: string
  background: string
  marker: string
  link: string
  due: string
  dueSoon: string
  dueOverdue: string
  codeBackground: string
  tag: string
  tagBackground: string
  highlight: string
  /// Ink for text sitting on `highlight`.
  highlightText: string
  /// A vivid accent for a flag/count that should stand out from the ordinary
  /// link/due colours — the inbox badge. From the theme's magenta, which is
  /// where several Omarchy themes keep their brightest warm colour (a gold, in
  /// the monochrome-blue themes that make everything else blue).
  flag: string
  /// The note list's selection highlight.
  selection: string
  /// The editor's own text-selection background. A separate token from
  /// `selection` on purpose — they're different colors in Envious (blue for
  /// the list row, red for selected text).
  selectedText: string
  focusHighlight: string
  fileListBackground: string
  blockquote: string
  completedTask: string
  footnote: string
  checkedCheckbox: string
  titleBarBackground: string
}

export interface OmarchyAppearance {
  colors: Record<string, string>
  font: string
  /// The current Omarchy theme's slug (its directory name, or a numeric id for
  /// an Aether-generated one). A theme file named after it overlays the
  /// derived palette, which is how "tokyo-night, but…" is written down.
  theme: string | null
}

export const enviousDark: EnvyTheme = {
  fontFamily: SYSTEM_UI_FONT,
  monoFamily: MONO_FONT,
  // Sized to match the terminal's editor text on Linux rather than the Mac's
  // Segoe-tuned 15px.
  fontSize: '12px',
  text: 'rgba(255, 255, 255, 0.847)',
  background: 'rgb(29, 30, 31)',
  marker: 'rgba(255, 255, 255, 0.247)',
  link: 'rgb(90, 128, 255)',
  due: 'rgb(255, 255, 255)',
  dueSoon: 'rgb(255, 188, 0)',
  dueOverdue: 'rgb(255, 75, 57)',
  codeBackground: 'rgb(55, 55, 55)',
  tag: 'rgb(52, 199, 89)',
  tagBackground: 'rgba(48, 209, 88, 0.153)',
  highlight: 'rgb(255, 188, 0)',
  highlightText: 'rgb(32, 29, 24)',
  flag: 'rgb(255, 188, 0)',
  selection: 'rgb(90, 128, 255)',
  selectedText: 'rgb(255, 75, 57)',
  focusHighlight: 'rgba(152, 168, 217, 0.25)',
  fileListBackground: 'rgb(29, 30, 31)',
  blockquote: 'rgba(255, 255, 255, 0.549)',
  completedTask: 'rgba(255, 255, 255, 0.549)',
  footnote: 'rgba(255, 255, 255, 0.549)',
  checkedCheckbox: 'rgb(52, 199, 89)',
  titleBarBackground: 'rgb(38, 38, 38)',
}

export const enviousLight: EnvyTheme = {
  fontFamily: SYSTEM_UI_FONT,
  monoFamily: MONO_FONT,
  fontSize: '12px',
  text: 'rgba(0, 0, 0, 0.85)',
  background: 'rgb(250, 250, 248)',
  marker: 'rgba(0, 0, 0, 0.30)',
  link: 'rgb(27, 79, 216)',
  due: 'rgba(0, 0, 0, 0.85)',
  dueSoon: 'rgb(176, 124, 0)',
  dueOverdue: 'rgb(212, 42, 28)',
  codeBackground: 'rgb(240, 239, 234)',
  tag: 'rgb(23, 132, 58)',
  tagBackground: 'rgba(23, 132, 58, 0.13)',
  highlight: 'rgba(255, 188, 0, 0.55)',
  highlightText: 'rgb(32, 29, 24)',
  flag: 'rgb(176, 124, 0)',
  selection: 'rgba(27, 79, 216, 0.18)',
  selectedText: 'rgba(212, 42, 28, 0.22)',
  focusHighlight: 'rgba(96, 122, 176, 0.30)',
  fileListBackground: 'rgb(250, 250, 248)',
  blockquote: 'rgba(0, 0, 0, 0.55)',
  completedTask: 'rgba(0, 0, 0, 0.55)',
  footnote: 'rgba(0, 0, 0, 0.55)',
  checkedCheckbox: 'rgb(23, 132, 58)',
  titleBarBackground: 'rgb(240, 239, 234)',
}

/// The CSS property each theme key ends up feeding, so a value can be checked
/// before it is set. Everything not listed here is a colour.
const CSS_PROPERTY: Partial<Record<keyof EnvyTheme, string>> = {
  fontFamily: 'font-family',
  monoFamily: 'font-family',
  fontSize: 'font-size',
}

/// Omarchy's `colors.toml` is a file we don't own, so a value can be anything.
/// `setProperty` silently drops a value it can't parse, which would leave the
/// variable holding whatever the *previous* theme set — a half-applied palette
/// that's worse than no theme at all. Check first and fall back to the Envious
/// default for that same key instead.
export function applyTheme(theme: EnvyTheme, dark = true) {
  const root = document.documentElement.style
  const defaults = dark ? enviousDark : enviousLight
  for (const [key, value] of Object.entries(theme)) {
    const prop = CSS_PROPERTY[key as keyof EnvyTheme] ?? 'color'
    const safe = CSS.supports(prop, value) ? value : defaults[key as keyof EnvyTheme]
    root.setProperty(`--envy-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, safe)
  }
  // Opaque twins of the two translucent surfaces, for overlays that sit on
  // top of the note rather than on the wallpaper: the link preview would
  // otherwise show the text beneath it through its own title bar.
  root.setProperty('--envy-background-opaque', toAlpha(theme.background, 1))
  root.setProperty('--envy-title-bar-background-opaque', toAlpha(theme.titleBarBackground, 1))
}

/// The editor's face size for a zoom factor, as the two CSS variables every
/// window reads. Shared by the main window and the pop-outs so a note looks
/// the same size wherever it is opened. Whole pixels: a 15×1.15 = 17.25px
/// face is the usual WebKit softness.
/// Spacing follows the zoom, up to a point: insets, paddings and the footer
/// grow with the text so a zoomed-in window doesn't read as crowded, but
/// they stop at 160% — past that, whitespace is wasting room the bigger
/// text needs — and never shrink below the 100% layout when zoomed out.
const SPACING_ZOOM_CAP = 1.6

export function applyEditorZoom(zoom: number) {
  const base = Number.parseFloat(enviousDark.fontSize)
  const px = Math.max(9, Math.round(base * zoom))
  const root = document.documentElement.style
  root.setProperty('--envy-font-size', `${px}px`)
  root.setProperty('--envy-line-height', `${Math.round(px * 1.6)}px`)
  const spacing = Math.min(SPACING_ZOOM_CAP, Math.max(1, zoom))
  root.setProperty('--envy-zoom-space', spacing.toFixed(3))
}

export function cssFontStack(family: string): string {
  const name = family.trim()
  if (!name) return MONO_FONT
  const quoted = /[\s,]/.test(name) && !name.startsWith('"') ? `"${name.replaceAll('"', '')}"` : name
  return `${quoted}, ui-monospace, monospace`
}

function pick(colors: Record<string, string>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = colors[key]
    if (value) return value
  }
  return fallback
}

function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.trim().replace('#', '')
  const h =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw.slice(0, 6)
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function toAlpha(color: string, alpha: number): string {
  const trimmed = color.trim()
  if (trimmed.startsWith('rgba(')) {
    return trimmed.replace(/rgba\(([^,]+),([^,]+),([^,]+),\s*[\d.]+\)/, `rgba($1,$2,$3, ${alpha})`)
  }
  if (trimmed.startsWith('rgb(')) {
    return trimmed.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
  }
  if (trimmed.startsWith('#')) return hexToRgba(trimmed, alpha)
  return color
}

function isLightMode(colors: Record<string, string>): boolean {
  const mode = (colors.mode ?? colors.theme_type ?? '').toLowerCase()
  return mode === 'light'
}

/// Hyprland blur only shows through if the surfaces themselves have alpha —
/// an opaque `rgb()` slab hides the wallpaper even with a transparent window.
///
/// `keep` names surfaces a theme file gave an alpha of its own: someone who
/// wrote `#1a1b26ff` meant it, and re-writing their alpha would make the file
/// and the screen disagree.
function withSurfaceAlpha(theme: EnvyTheme, light: boolean, keep?: Set<string>): EnvyTheme {
  // Windows WebView2 is an opaque HWND; alpha on every surface only costs
  // compositor work. Hyprland blur is a Linux-only trick.
  if (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)) {
    return theme
  }
  // High enough that glyph coverage doesn't mix with the wallpaper blur —
  // that's the usual "WebKit looks soft" look — but still short of opaque so
  // Hyprland blur remains visible in the chrome.
  const body = light ? 0.92 : 0.88
  const chrome = light ? 0.94 : 0.90
  const code = light ? 0.82 : 0.72
  const alpha = (role: keyof EnvyTheme, value: number) =>
    keep?.has(role) ? theme[role] : toAlpha(theme[role], value)
  return {
    ...theme,
    background: alpha('background', body),
    fileListBackground: alpha('fileListBackground', body),
    titleBarBackground: alpha('titleBarBackground', chrome),
    codeBackground: alpha('codeBackground', code),
  }
}

/// Contrast floors for the roles that carry text, measured against the editor
/// and list backgrounds. The Envious faces sit at 4.5–5 for body and secondary
/// text and about 2.1–2.4 for syntax markers, and those are the floors: a
/// theme that already reads at least as well as Envious is left exactly as
/// written. Body text is held to WCAG AA (4.5:1); markers are meant to recede,
/// so they only have to be visible.
const TEXT_CONTRAST = 4.5
const MARKER_CONTRAST = 2.4

export function omarchyToEnvy(colors: Record<string, string>, fontFamily: string): EnvyTheme {
  const light = isLightMode(colors)
  const background = pick(colors, ['background', 'bg'], '#1a1b26')
  const foreground = pick(colors, ['foreground', 'fg'], '#c0caf5')
  const muted = pick(colors, ['muted', 'dark_foreground', 'dark_fg'], light ? '#6c6c6c' : '#565f89')
  const accent = pick(colors, ['accent', 'blue'], '#7aa2f7')
  const red = pick(colors, ['red'], '#f7768e')
  const green = pick(colors, ['green'], '#9ece6a')
  const yellow = pick(colors, ['yellow'], '#e0af68')
  const darker = pick(colors, ['dark_background', 'dark_bg', 'darker_background'], background)
  const lighter = pick(colors, ['lighter_background', 'lighter_bg'], light ? '#e8e8e8' : '#24283b')
  const bright = pick(colors, ['bright_foreground', 'bright_fg', 'light_foreground'], foreground)
  const darkFg = pick(colors, ['dark_foreground', 'dark_fg'], muted)
  const magenta = pick(colors, ['bright_magenta', 'magenta'], yellow)

  // Text sits on `background` in the editor and on `darker` in the note list;
  // a colour has to read on both. Only the text-bearing roles are adjusted —
  // fills built from the same colours (selection, tag chip, search highlight)
  // keep the theme's own value so the palette still looks like the theme.
  const surfaces = [background, darker]
  const text = (color: string) => legible(color, surfaces, TEXT_CONTRAST)

  // Ink for search matches: whichever of the theme's dark surface and its
  // foreground reads better on the highlight, then pushed to the floor. Light
  // themes are the case that matters — a light `dark_background` on a
  // mid-tone yellow is invisible.
  const highlight = yellow
  const highlightInk = [darker, foreground]
    .map((c) => ({ c, ratio: contrastRatio(parseHex(c) ?? { r: 0, g: 0, b: 0 }, parseHex(highlight) ?? { r: 0, g: 0, b: 0 }) }))
    .sort((a, b) => b.ratio - a.ratio)[0].c

  return withSurfaceAlpha(
    {
      fontFamily,
      monoFamily: fontFamily,
      fontSize: '12px',
      text: text(foreground),
      background,
      marker: legible(muted, surfaces, MARKER_CONTRAST),
      link: text(accent),
      due: text(bright),
      dueSoon: text(yellow),
      dueOverdue: text(red),
      codeBackground: lighter,
      tag: text(green),
      tagBackground: hexToRgba(green.startsWith('#') ? green : '#9ece6a', 0.16),
      highlight,
      highlightText: legible(highlightInk, [highlight], TEXT_CONTRAST),
      // The theme's most vivid warm accent. Several Omarchy themes keep it under
      // `magenta` (a gold in the monochrome-blue themes, a real magenta/pink in
      // colourful ones) — a genuine standout next to the blue link/due colours.
      flag: text(magenta),
      selection: light ? hexToRgba(accent.startsWith('#') ? accent : '#7aa2f7', 0.18) : accent,
      selectedText: light
        ? hexToRgba(red.startsWith('#') ? red : '#f7768e', 0.22)
        : hexToRgba(red.startsWith('#') ? red : '#f7768e', 0.45),
      focusHighlight: hexToRgba(accent.startsWith('#') ? accent : '#7aa2f7', 0.28),
      fileListBackground: darker,
      blockquote: text(darkFg),
      completedTask: text(darkFg),
      footnote: text(darkFg),
      checkedCheckbox: green,
      titleBarBackground: darker,
    },
    light,
  )
}

let omarchy: OmarchyAppearance | null = null
let appearanceListener: (() => void) | null = null

export function currentOmarchy(): OmarchyAppearance | null {
  return omarchy
}

export function setOmarchyAppearance(next: OmarchyAppearance) {
  omarchy = next
  appearanceListener?.()
}

function resolveFont(omarchyFont: string | undefined): string {
  const source = getString('appearance', 'font')
  const custom = getString('appearance', 'font_family')
  if (source === 'custom' && custom.trim()) return cssFontStack(custom)
  if (omarchyFont) return cssFontStack(omarchyFont)
  return MONO_FONT
}

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

const BUILT_IN_THEMES = ['omarchy', 'system', 'dark', 'light']

/// The surfaces a theme file wrote down, as role names, so the blur treatment
/// leaves them alone. A colour in a theme file is used exactly as written —
/// somebody chose it, and quietly changing its alpha would make the file and
/// the screen disagree. The blur alpha is for surfaces Envy derived itself.
function pinnedSurfaces(tokens: Record<string, string>): Set<string> {
  const pinned = new Set<string>()
  for (const [token, role] of [
    ['background', 'background'],
    ['file_list_background', 'fileListBackground'],
    ['title_bar_background', 'titleBarBackground'],
    ['code_background', 'codeBackground'],
  ]) {
    if (tokens[token] && cssToRgb(tokens[token])) pinned.add(role)
  }
  return pinned
}

/// The theme as it should look right now: `appearance.theme` picks a base
/// face, and a theme file — named outright, or named after the current
/// Omarchy theme — paints over it.
function resolveAppearance(): { theme: EnvyTheme; dark: boolean; notices: string[] } {
  // Both platforms default to Envious dark; a machine running Omarchy defaults
  // to following it instead, for the theme here and for the font in
  // `resolveFont`. Decided at resolve time rather than baked into the schema:
  // the desktop's colours arrive asynchronously (`omarchy_appearance`), so at
  // first paint there is nothing to follow yet, and one shared schema file
  // cannot carry a per-machine default anyway. An explicit `appearance.theme`
  // always wins — this only fills in when the setting is unset.
  const omarchyReady = Boolean(omarchy?.colors?.background)
  const selection = getString('appearance', 'theme') || (omarchyReady ? 'omarchy' : 'dark')
  const builtIn = BUILT_IN_THEMES.includes(selection)
  // In Omarchy mode a file named after the current Omarchy theme is an
  // override for that theme alone, which is what makes partial overrides the
  // point: three lines change three colours of tokyo-night and nothing else.
  const file = builtIn
    ? selection === 'omarchy' && omarchy?.theme
      ? themeFile(omarchy.theme)
      : null
    : themeFile(selection)
  const tokens = file?.tokens ?? {}
  const meta = metaFromTokens(tokens)
  const font = meta.fontFamily ? cssFontStack(meta.fontFamily) : resolveFont(omarchy?.font)

  let dark: boolean
  let base: EnvyTheme
  if (selection === 'omarchy' && omarchyReady && omarchy) {
    dark = !isLightMode(omarchy.colors)
    base = omarchyToEnvy(omarchy.colors, font)
  } else {
    // A file selected by name says which Envious face it was written against;
    // an Omarchy override doesn't get to flip the desktop's own light/dark.
    dark = builtIn
      ? selection === 'system' || selection === 'omarchy'
        ? prefersDark()
        : selection !== 'light'
      : (file?.mode ?? 'dark') === 'dark'
    base = withSurfaceAlpha(
      { ...(dark ? enviousDark : enviousLight), fontFamily: font, monoFamily: font },
      !dark,
    )
  }
  if (meta.fontSize) base = { ...base, fontSize: meta.fontSize }
  if (!file) return { theme: base, dark, notices: [] }

  const theme = withSurfaceAlpha(overlayTokens(base, tokens), !dark, pinnedSurfaces(tokens))
  const notices = [
    ...file.problems,
    // An override for an Omarchy theme rides on whatever colors.toml says it
    // is. A file claiming the other mode is a mistake worth naming, but the
    // desktop's own judgement is not something a colour override gets to flip.
    ...(builtIn && file.mode && file.mode !== (dark ? 'dark' : 'light')
      ? [`mode is ${file.mode} but the Omarchy theme is ${dark ? 'dark' : 'light'}`]
      : []),
    ...legibilityNotices(theme, tokens),
  ].map((n) => `themes/${file.name}.md: ${n}`)
  return { theme, dark, notices }
}

let applied: { theme: EnvyTheme; dark: boolean; notices: string[] } = {
  theme: enviousDark,
  dark: true,
  notices: [],
}

/// The theme currently on screen — what "export the current theme" exports.
export function currentTheme(): { theme: EnvyTheme; dark: boolean } {
  return { theme: applied.theme, dark: applied.dark }
}

/// Anything wrong with the theme file that is in play, for the footer.
export function themeNotices(): string[] {
  return applied.notices
}

/// OpenType features for all text, as a `font-feature-settings` value.
/// `appearance.font_features` verbatim when set. Otherwise automatic: `ss01`
/// for a Cascadia family, whose script-style italic letters (the cursive r,
/// s, f and l) sit behind that set and are off by default, and nothing for
/// any other font — a set number means something different in every face.
export function fontFeatures(fontStack: string): string {
  const custom = getString('appearance', 'font_features').trim()
  const chosen = custom || (/cas(cadia|kaydia)/i.test(fontStack) ? 'ss01' : '')
  const value = chosen
    .split(',')
    .map((f) => f.trim().replaceAll('"', ''))
    .filter(Boolean)
    .map((f) => `"${f}"`)
    .join(', ')
  if (!value) return 'normal'
  return CSS.supports('font-feature-settings', value) ? value : 'normal'
}

export function applyStoredAppearance() {
  applied = resolveAppearance()
  applyTheme(applied.theme, applied.dark)
  document.documentElement.style.setProperty(
    '--envy-font-features',
    fontFeatures(applied.theme.fontFamily),
  )
  document.documentElement.style.colorScheme = applied.dark ? 'dark' : 'light'
  document.documentElement.classList.toggle('theme-light', !applied.dark)
  document.documentElement.classList.toggle('theme-dark', applied.dark)
}

/// Subscribe to Omarchy theme/font changes and apply once the first payload
/// arrives. `onApply` runs after every apply so a window can refresh zoom.
///
/// The config and the theme files are pulled in here rather than by the
/// caller: every window that shows notes needs the same three inputs
/// (appearance settings, theme files, Omarchy's palette), and making each one
/// remember to load two of them by hand is how they drift apart.
export async function initAppearance(onApply?: () => void) {
  appearanceListener = () => {
    applyStoredAppearance()
    onApply?.()
  }
  await Promise.all([initConfig(), initThemes(() => appearanceListener?.())])
  // Only for a change that came from the file: a change made in this window
  // came from a control that re-applies the theme itself, and re-applying it a
  // second time on every unrelated checkbox is work for nothing.
  onConfigChange((local) => {
    if (!local) appearanceListener?.()
  })
  applyStoredAppearance()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    appearanceListener?.()
  })
  try {
    omarchy = await invoke<OmarchyAppearance>('omarchy_appearance')
    appearanceListener()
    await listen<OmarchyAppearance>('omarchy-appearance', (event) => {
      omarchy = event.payload
      appearanceListener?.()
    })
  } catch {
    // Outside Tauri (plain browser) — Envious faces still apply.
  }
}
