//! GFM pipe tables: detect a `| header |` / `| --- |` / `| cell |` block,
//! and continue it on Enter / Tab the way lists continue on Enter / Tab.
//!
//! The file still holds the pipes — Envy never rewrites a table into HTML.
//! When the cursor is outside the block the styler replaces it with an HTML
//! table matching the Omarchy manual; this module is the parser plus keymap.

import { EditorView, keymap } from '@codemirror/view'
import { EditorSelection, Prec, type EditorState, type Text } from '@codemirror/state'

export type CellAlign = 'left' | 'center' | 'right'

export interface TableBlock {
  from: number
  to: number
  header: string[]
  aligns: CellAlign[]
  rows: string[][]
  src: string
}

export function findTableBlocks(doc: Text): TableBlock[] {
  const out: TableBlock[] = []
  let n = 1
  let inFence = false
  while (n <= doc.lines) {
    const text = doc.line(n).text
    // A pipe table inside a fenced block is source, not a table.
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      n++
      continue
    }
    if (inFence || !isTableLine(text)) {
      n++
      continue
    }
    let end = n
    while (end < doc.lines) {
      const next = doc.line(end + 1).text
      if (/^\s*```/.test(next) || !isTableLine(next)) break
      end++
    }
    let sep = -1
    for (let i = n; i <= end; i++) {
      if (isTableSep(doc.line(i).text)) {
        sep = i
        break
      }
    }
    if (sep > n) {
      const header = splitCells(doc.line(n).text).map((c) => c.trim())
      const aligns = splitCells(doc.line(sep).text).map(alignOf)
      const rows: string[][] = []
      for (let i = sep + 1; i <= end; i++) {
        if (isTableSep(doc.line(i).text)) continue
        rows.push(splitCells(doc.line(i).text).map((c) => c.trim()))
      }
      // Block replacements have to cover whole lines: from the header's start
      // to the start of the next line (or the end of the document). Ending at
      // `line.to` (before the newline) is not a valid block range, so CodeMirror
      // drops the widget and the pipes stay on screen.
      const from = doc.line(n).from
      const to = end < doc.lines ? doc.line(end + 1).from : doc.length
      out.push({ from, to, header, aligns, rows, src: doc.sliceString(from, to) })
    }
    n = end + 1
  }
  return out
}

function alignOf(cell: string): CellAlign {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

/// A line that can belong to a pipe table: starts with `|` (after indent)
/// and has at least two pipes, so a lone `|` is not a table.
export function isTableLine(line: string): boolean {
  if (!/^\s*\|/.test(line)) return false
  let pipes = 0
  forEachPipe(line, () => {
    pipes++
  })
  return pipes >= 2
}

/// The delimiter row: `| --- | :---: | ---: |`
export function isTableSep(line: string): boolean {
  if (!isTableLine(line)) return false
  const cells = splitCells(line)
  return cells.length >= 1 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()))
}

/// Cells of a table line, outer pipes stripped. `\|` and pipes inside
/// `[[wiki|alias]]` or `` `code` `` are not splits.
export function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let i = 0
  while (i < s.length) {
    const skip = skipProtected(s, i)
    if (skip > i) {
      cur += s.slice(i, skip)
      i = skip
      continue
    }
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 2
      continue
    }
    if (s[i] === '|') {
      cells.push(cur)
      cur = ''
      i++
      continue
    }
    cur += s[i]
    i++
  }
  cells.push(cur)
  return cells
}

/// Absolute offsets of structural `|` characters on this line.
export function forEachPipe(line: string, fn: (rel: number) => void) {
  let i = 0
  while (i < line.length) {
    const skip = skipProtected(line, i)
    if (skip > i) {
      i = skip
      continue
    }
    if (line[i] === '\\' && line[i + 1] === '|') {
      i += 2
      continue
    }
    if (line[i] === '|') fn(i)
    i++
  }
}

function skipProtected(s: string, i: number): number {
  if (s[i] === '[' && s[i + 1] === '[') {
    const end = s.indexOf(']]', i + 2)
    if (end !== -1) return end + 2
  }
  if (s[i] === '`') {
    const end = s.indexOf('`', i + 1)
    if (end !== -1) return end + 1
  }
  return i
}

function emptyRow(cols: number): string {
  const n = Math.max(2, cols)
  return '| ' + Array.from({ length: n }, () => ' ').join('| ') + '|'
}

function isEmptyTableRow(line: string): boolean {
  return splitCells(line).every((c) => c.trim() === '')
}

function continueTable(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (!isTableLine(line.text)) return false
  if (isTableSep(line.text)) return false
  if (isEmptyTableRow(line.text)) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      userEvent: 'input',
    })
    return true
  }
  const cols = splitCells(line.text).length
  const row = emptyRow(cols)
  const insertAt = line.to
  const caret = insertAt + 1 + 2 // after `\n| `
  view.dispatch({
    changes: { from: insertAt, insert: '\n' + row },
    selection: { anchor: caret },
    userEvent: 'input',
  })
  return true
}

/// A cell's content range on a table line, as absolute document offsets.
export interface CellRange {
  from: number
  to: number
}

/// The content ranges of every cell on one table line, trimmed.
///
/// Only a pipe that *begins* a cell counts, which is what the last pipe on a
/// line never does — treating the closing pipe as an opener is how Tab used to
/// walk off the end of a row and type past it. A line written without its
/// closing pipe (`| a | b`) still ends in a cell, so the tail after the last
/// pipe counts when it holds anything.
///
/// An empty cell's range is a caret one space in from its opening pipe, where
/// the `| x |` padding convention puts the content — so typing there produces
/// `| x |` rather than `|x  |` or `|  x|`.
export function cellRangesOn(text: string, lineFrom: number): CellRange[] {
  const pipes: number[] = []
  forEachPipe(text, (rel) => pipes.push(rel))
  if (pipes.length === 0) return []
  const spans: Array<[number, number]> = []
  for (let i = 0; i < pipes.length - 1; i++) spans.push([pipes[i] + 1, pipes[i + 1]])
  const tail = pipes[pipes.length - 1] + 1
  if (text.slice(tail).trim() !== '') spans.push([tail, text.length])
  return spans.map(([start, end]) => {
    let from = start
    let to = end
    while (from < to && /\s/.test(text[from])) from++
    while (to > from && /\s/.test(text[to - 1])) to--
    if (from === to) from = to = Math.min(start + 1, end)
    return { from: lineFrom + from, to: lineFrom + to }
  })
}

/// The next table row in `dir`, skipping delimiter rows — so Tab off the end of
/// the header lands in the first data row rather than in `| --- |`. `last` is
/// the final table line seen, which is where a new row is appended.
function stepTableRow(doc: Text, n: number, dir: 1 | -1): { line: number | null; last: number } {
  let last = n
  for (let i = n + dir; i >= 1 && i <= doc.lines; i += dir) {
    const text = doc.line(i).text
    if (!isTableLine(text)) break
    last = i
    if (!isTableSep(text)) return { line: i, last }
  }
  return { line: null, last }
}

/// The cell Tab (`dir` 1) or Shift-Tab (`dir` -1) should land in from `pos`, or
/// null when there is none — the last cell of the last row going forwards (the
/// caller appends a row), the first header cell going backwards.
///
/// Pure, and the single definition of "the next cell" for both editing modes:
/// the raw-pipes keymap below and the rendered widget in styler.ts.
export function nextCellRange(doc: Text, pos: number, dir: 1 | -1): CellRange | null {
  const line = doc.lineAt(pos)
  if (!isTableLine(line.text)) return null
  const cells = cellRangesOn(line.text, line.from)
  if (cells.length === 0) return null
  // The cell `pos` is in: the first whose content it has not passed, else the
  // last one (a caret in the padding after the final cell).
  let index = cells.findIndex((c) => pos <= c.to)
  if (index === -1) index = cells.length - 1
  const next = index + dir
  if (next >= 0 && next < cells.length) return cells[next]
  const { line: rowLine } = stepTableRow(doc, line.number, dir)
  if (rowLine === null) return null
  const row = cellRangesOn(doc.line(rowLine).text, doc.line(rowLine).from)
  if (row.length === 0) return null
  return dir > 0 ? row[0] : row[row.length - 1]
}

/// Tab / Shift-Tab between cells, in the raw pipes.
///
/// The target cell's content is *selected*, not just pointed at, so typing
/// replaces it — which is what makes tabbing through a fresh `| Column 1 |`
/// skeleton fill it in rather than type into the placeholder. A selection is
/// therefore a perfectly ordinary state to Tab out of, and is not bailed on.
function moveTableCell(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  const sel = state.selection.main
  const pos = dir > 0 ? sel.to : sel.from
  const line = state.doc.lineAt(pos)
  if (!isTableLine(line.text)) return false
  const target = nextCellRange(state.doc, pos, dir)
  if (target) {
    view.dispatch({ selection: EditorSelection.range(target.from, target.to) })
    return true
  }
  // Backwards out of the first header cell: there is nowhere to go, so Tab
  // keeps its usual meaning.
  if (dir < 0) return false
  // Forwards off the last cell of the last row: add one, the way Enter does.
  const { last } = stepTableRow(state.doc, line.number, 1)
  const end = state.doc.line(last)
  const row = emptyRow(splitCells(line.text).length)
  const caret = end.to + 1 + 2 // after `\n| `
  view.dispatch({
    changes: { from: end.to, insert: '\n' + row },
    selection: { anchor: caret },
    userEvent: 'input',
  })
  return true
}

// --- Serialising a table back to pipes ---------------------------------------
//
// The file always holds the pipes, so every UI gesture (typing in a rendered
// cell, adding a row, re-aligning a column) ends up here: cells in, one source
// line out. These are pure string functions with no view attached, so the
// widget in styler.ts and the paste handler below share exactly one idea of
// what a row looks like — and they can be exercised without an editor.

/// Escapes a cell for a pipe row: a structural `|` becomes `\|`, and any line
/// break collapses to a space (a pipe-table cell is one line by construction).
///
/// `forEachPipe` decides what "structural" means, so a pipe already escaped, or
/// one inside `[[wiki|alias]]` or `` `code` ``, is left exactly as it was — the
/// same rule `splitCells` reads by, which is what makes the round trip stable.
export function escapeTableCell(cell: string): string {
  let out = ''
  let last = 0
  forEachPipe(cell, (rel) => {
    out += cell.slice(last, rel) + '\\|'
    last = rel + 1
  })
  out += cell.slice(last)
  return out.replace(/[\r\n]+/g, ' ')
}

/// One row's source line, with the single-space padding a hand-written table
/// has: `| a | b |`. Cells are trimmed, so the padding is the function's, not
/// the caller's.
export function serializeTableRow(cells: string[]): string {
  return '| ' + cells.map((c) => escapeTableCell(c.trim())).join(' | ') + ' |'
}

/// One delimiter cell: `---`, `:---:` or `---:`, widened to `width` when the
/// block is being padded. Never fewer than three dashes, whatever the width.
function separatorCell(align: CellAlign, width: number): string {
  const colons = align === 'center' ? 2 : align === 'left' ? 0 : 1
  const dashes = '-'.repeat(Math.max(3, width - colons))
  if (align === 'center') return `:${dashes}:`
  if (align === 'right') return `${dashes}:`
  return dashes
}

/// The delimiter row for a set of alignments.
export function serializeSeparatorRow(aligns: CellAlign[]): string {
  return '| ' + aligns.map((a) => separatorCell(a, 3)).join(' | ') + ' |'
}

/// A whole block's source from its parts. `trailingNewline` mirrors the block
/// it replaces: a table in the middle of a note ends with one, a table at the
/// very end of the file does not.
export function serializeTable(
  header: string[],
  aligns: CellAlign[],
  rows: string[][],
  trailingNewline: boolean,
): string {
  const lines = [serializeTableRow(header), serializeSeparatorRow(aligns)]
  for (const row of rows) lines.push(serializeTableRow(row))
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/// Re-pads a block so the pipes line up: every column as wide as its widest
/// cell, the delimiter row widened to match while keeping its colons and at
/// least three dashes. Ragged rows are filled out to the column count.
///
/// Widths are counted in code points (`[...s].length`), not UTF-16 units, so an
/// emoji or an astral character counts as one column the way it reads. This is
/// cosmetic — the parser does not care — which is why it runs once on the way
/// out of a table rather than on every keystroke.
export function padTableSource(src: string): string {
  const trailing = src.endsWith('\n') ? '\n' : ''
  const body = trailing ? src.slice(0, -1) : src
  const lines = body.split('\n')
  if (lines.length === 0) return src
  const indent = /^\s*/.exec(lines[0])![0]
  const parsed = lines.map((l) => ({
    sep: isTableSep(l),
    cells: splitCells(l).map((c) => c.trim()),
  }))
  const cols = Math.max(...parsed.map((r) => r.cells.length))
  const sepRow = parsed.find((r) => r.sep)
  const aligns: CellAlign[] = Array.from({ length: cols }, (_, i) =>
    alignOf(sepRow?.cells[i] ?? '---'),
  )
  // `:---` and `---` both mean left, and the alignment model cannot tell them
  // apart — so the written marker is remembered separately rather than being
  // silently normalised away under someone's cursor.
  const explicitLeft = aligns.map(
    (a, i) => a === 'left' && (sepRow?.cells[i]?.startsWith(':') ?? false),
  )
  // The delimiter's own markers set a floor on the width, so a `:---:` under a
  // one-character column still lines up instead of poking out past it.
  const widths: number[] = aligns.map((a, i) =>
    a === 'center' ? 5 : a === 'right' || explicitLeft[i] ? 4 : 3,
  )
  for (const row of parsed) {
    if (row.sep) continue
    for (let i = 0; i < cols; i++) {
      const cell = escapeTableCell(row.cells[i] ?? '')
      widths[i] = Math.max(widths[i], [...cell].length)
    }
  }
  const out = parsed.map((row) => {
    const cells = row.sep
      ? aligns.map((a, i) =>
          explicitLeft[i]
            ? ':' + '-'.repeat(Math.max(3, widths[i] - 1))
            : separatorCell(a, widths[i]),
        )
      : Array.from({ length: cols }, (_, i) => {
          const cell = escapeTableCell(row.cells[i] ?? '')
          return cell + ' '.repeat(Math.max(0, widths[i] - [...cell].length))
        })
    return indent + '| ' + cells.join(' | ') + ' |'
  })
  return out.join('\n') + trailing
}

/// The document line numbers of a block's rows — header first, delimiter rows
/// skipped. The inverse of the `rows` array `findTableBlocks` builds, so row
/// index 0 is the header and index n+1 is `block.rows[n]`.
export function tableRowLines(doc: Text, block: TableBlock): number[] {
  const first = doc.lineAt(block.from).number
  const last = doc.lineAt(Math.max(block.from, block.to - 1)).number
  const out: number[] = []
  for (let n = first; n <= last; n++) {
    const text = doc.line(n).text
    if (!isTableLine(text)) break
    if (isTableSep(text)) continue
    out.push(n)
  }
  return out
}

// --- Inserting a table -------------------------------------------------------

/// A fresh table: two named columns and one empty row. The header text is
/// selected on insert, so the first thing typed replaces it.
export const TABLE_SKELETON = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |'
const FIRST_HEADER = 'Column 1'

/// The blank lines a block needs to stand on its own where the selection is:
/// one before when the caret is mid-paragraph or directly under a paragraph,
/// one after when text follows it. Shared by the insert command and the paste
/// handler so a table lands the same way however it was asked for.
function blockPadding(
  state: EditorState,
  from: number,
  to: number,
): { prefix: string; suffix: string } {
  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)
  const head = startLine.text.slice(0, from - startLine.from)
  const tail = endLine.text.slice(to - endLine.from)
  let prefix = head.trim() !== '' ? '\n\n' : ''
  // Caret at the start of a line that sits directly under a paragraph: one
  // blank line is enough to make the table a block of its own.
  if (!prefix && startLine.number > 1 && state.doc.line(startLine.number - 1).text.trim() !== '') {
    prefix = '\n'
  }
  return { prefix, suffix: tail.trim() !== '' ? '\n\n' : '' }
}

/// Inserts a 2×2 skeleton at the caret and selects "Column 1".
///
/// The selection lands *inside* the new block, so it shows as raw pipes rather
/// than the rendered table — which is exactly right for a header you are about
/// to overtype. It renders the moment the caret leaves.
export function insertTable(view: EditorView): boolean {
  const sel = view.state.selection.main
  const { prefix, suffix } = blockPadding(view.state, sel.from, sel.to)
  const insert = prefix + TABLE_SKELETON + suffix
  // Past the prefix and the opening `| ` is the first header cell.
  const cell = sel.from + prefix.length + 2
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(cell, cell + FIRST_HEADER.length),
    userEvent: 'input',
    scrollIntoView: true,
  })
  view.focus()
  return true
}

// --- Pasting a spreadsheet ---------------------------------------------------

/// A pasted TSV/CSV block as a pipe table, or null to paste it verbatim.
///
/// Tabs are decisive: nothing else in prose puts the same number of tabs on
/// every line. Commas are not, so they only count when the text cannot
/// plausibly be prose — no pipes (which would need escaping and probably mean
/// it is already a table), no sentence break (`. `), nothing over 200
/// characters, and the same comma count on every line.
export function delimitedToTable(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const rows = lines.filter((l) => l.trim() !== '')
  if (rows.length < 2) return null

  const tabs = rows.map((l) => l.split('\t').length - 1)
  if (tabs[0] >= 1 && tabs.every((t) => t === tabs[0])) {
    return tableFromCells(rows.map((l) => l.split('\t')))
  }

  const commas = rows.map((l) => l.split(',').length - 1)
  const prosey = rows.some((l) => l.includes('|') || /\.\s/.test(l) || l.length > 200)
  if (!prosey && commas[0] >= 1 && commas.every((c) => c === commas[0])) {
    return tableFromCells(rows.map((l) => l.split(',')))
  }
  return null
}

/// First row as the header, the rest as body rows, padded so it reads as a
/// table in the file as well as on screen.
function tableFromCells(cells: string[][]): string {
  const cols = Math.max(...cells.map((r) => r.length))
  const fill = (row: string[]) => Array.from({ length: cols }, (_, i) => row[i] ?? '')
  const aligns: CellAlign[] = Array.from({ length: cols }, () => 'left')
  return padTableSource(serializeTable(fill(cells[0]), aligns, cells.slice(1).map(fill), false))
}

/// Pasting a spreadsheet selection into a note writes a table rather than a
/// wall of tabs. Anything that isn't unambiguously tabular falls through to
/// CodeMirror's own paste handling untouched.
const tablePaste = EditorView.domEventHandlers({
  paste(event, view) {
    // A paste into a rendered cell belongs to the widget, which sanitises it
    // to one line of text itself.
    if ((event.target as HTMLElement | null)?.closest?.('.envy-md-table-wrap')) return false
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return false
    const sel = view.state.selection.main
    // Inside a table already: the pipes the user is editing win.
    if (isTableLine(view.state.doc.lineAt(sel.from).text)) return false
    const table = delimitedToTable(text)
    if (!table) return false
    event.preventDefault()
    const { prefix, suffix } = blockPadding(view.state, sel.from, sel.to)
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: prefix + table + suffix },
      // After the table, where typing carries on — the block renders at once.
      selection: { anchor: sel.from + prefix.length + table.length },
      userEvent: 'input.paste',
      scrollIntoView: true,
    })
    return true
  },
})

/// Enter continues a row; Tab / Shift-Tab walk cells. Same Prec.high as lists,
/// but each command returns false off a table line so lists keep those keys.
/// The paste handler rides along in the same extension so every window that
/// already installs `tableEditing` — main, pop-out and pinned — gets it.
export const tableEditing = [
  Prec.high(
    keymap.of([
      { key: 'Enter', run: continueTable },
      { key: 'Tab', run: (v) => moveTableCell(v, 1) },
      { key: 'Shift-Tab', run: (v) => moveTableCell(v, -1) },
    ]),
  ),
  tablePaste,
]
