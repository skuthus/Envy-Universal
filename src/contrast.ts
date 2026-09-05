// Envy-Linux: legibility floor for theme-driven text colours.
//
// Omarchy themes are written for terminals and window borders, where a dim
// `muted` or `dark_foreground` is a design choice. Envy renders paragraphs of
// notes in those roles, and several shipped themes put them below 2:1 against
// the background — unreadable at 12px. `legible` keeps the theme's hue but
// pulls a colour toward white or black (whichever the background is not)
// until it clears the requested WCAG contrast ratio.

export interface Rgb {
  r: number
  g: number
  b: number
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored); anything else is null.
export function parseHex(color: string): Rgb | null {
  const raw = color.trim().replace(/^#/, '')
  const h = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw.slice(0, 6)
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h) || (raw.length !== 3 && raw.length !== 6 && raw.length !== 8)) {
    return null
  }
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  }
}

export function toHex({ r, g, b }: Rgb): string {
  const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/// WCAG relative luminance, 0 (black) to 1 (white).
export function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// WCAG contrast ratio, 1 (identical) to 21 (black on white).
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  }
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/// `color`, nudged toward white or black until it reads at `minRatio` against
/// every one of `backgrounds`. Colours that already clear the floor come back
/// untouched, so a well-built theme is never altered. Non-hex input is
/// returned as-is: the Rust side only forwards hex, and the Envious faces
/// don't go through here.
export function legible(color: string, backgrounds: string[], minRatio: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  const bgs = backgrounds.map(parseHex).filter((c): c is Rgb => c !== null)
  if (bgs.length === 0) return color

  const worst = (c: Rgb) => Math.min(...bgs.map((bg) => contrastRatio(c, bg)))
  if (worst(rgb) >= minRatio) return color

  // Head for whichever pole the backgrounds are furthest from. Dark themes
  // brighten, light themes darken; a mixed pair goes with the majority.
  const pole = worst(WHITE) >= worst(BLACK) ? WHITE : BLACK
  if (worst(pole) < minRatio) return toHex(pole)

  // Contrast grows monotonically along the blend, so bisect for the smallest
  // move that clears the floor — the result keeps as much of the theme's
  // colour as legibility allows.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (worst(mix(rgb, pole, mid)) >= minRatio) hi = mid
    else lo = mid
  }
  return toHex(mix(rgb, pole, hi))
}
