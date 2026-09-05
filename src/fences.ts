//! GFM fenced code: ` ```lang ` / body / ` ``` `.
//!
//! The file still holds the fences — Envy never rewrites a block into HTML.
//! When the cursor is outside it the styler replaces the block with a `<pre>`
//! matching the Omarchy manual.

import type { Text } from '@codemirror/state'

export interface FenceBlock {
  from: number
  to: number
  /// Start of the first body line (or the opening fence if the body is empty).
  bodyFrom: number
  lang: string
  body: string
  src: string
}

/// Closed fenced blocks in `doc`. Unclosed openers are left as ordinary text.
/// The range is whole lines — from the opening fence to the start of the line
/// after the closer — so a block replace is valid in CodeMirror.
export function findFencedBlocks(doc: Text): FenceBlock[] {
  const out: FenceBlock[] = []
  let n = 1
  while (n <= doc.lines) {
    const openLine = doc.line(n)
    const open = /^( {0,3})(`{3,})([^`]*)$/.exec(openLine.text)
    if (!open) {
      n++
      continue
    }
    const ticks = open[2].length
    const lang = open[3].trim().split(/\s+/)[0] ?? ''
    let end = -1
    for (let i = n + 1; i <= doc.lines; i++) {
      const close = /^( {0,3})(`{3,})[ \t]*$/.exec(doc.line(i).text)
      if (close && close[2].length >= ticks) {
        end = i
        break
      }
    }
    if (end === -1) {
      n++
      continue
    }
    const from = openLine.from
    const to = end < doc.lines ? doc.line(end + 1).from : doc.length
    const hasBody = end > n + 1
    const bodyFrom = hasBody ? doc.line(n + 1).from : from
    const body = hasBody ? doc.sliceString(doc.line(n + 1).from, doc.line(end - 1).to) : ''
    out.push({ from, to, bodyFrom, lang, body, src: doc.sliceString(from, to) })
    n = end + 1
  }
  return out
}
