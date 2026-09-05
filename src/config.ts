//! The settings file (`~/.config/envy/config.md`) as the app sees it.
//!
//! Every preference Envy has used to live in `localStorage`, which is a place
//! only Envy can read and nobody can edit. The truth now sits in a markdown
//! file with one ```toml fence in it, so an agent — or a person with an editor
//! — can change any setting, and Envy follows along live. This module is the
//! only thing in the frontend that talks to that file.
//!
//! `config/schema.json` is the single source of truth for what keys exist,
//! what they mean and what they default to. Nothing here invents a key: the
//! defaults, the validation and the one-off migration out of `localStorage`
//! are all driven by the schema, so adding a setting is a schema edit plus a
//! control, never a third list to keep in step.
//!
//! Rust owns the file itself (parsing, comment-preserving writes, the watcher).
//! This side holds the parsed values in memory, fills in defaults, reports
//! problems, and writes changes back through `config_set`.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import schemaJson from '../config/schema.json'

export type ConfigValue = string | number | boolean

type KeyType = 'bool' | 'int' | 'number' | 'string' | 'enum' | 'path' | 'theme'

interface KeySpec {
  key: string
  type: KeyType
  default: ConfigValue
  values?: ConfigValue[]
  min?: number
  max?: number
  label?: string
  doc?: string
  /// "rust" for the keys Rust reads before the webview exists. The frontend
  /// still shows them; it just isn't the one applying them.
  owner?: string
  /// The `localStorage` key (or `file:<name>`, for the ones Rust kept in files)
  /// this setting used to live in. Only read once, on the launch that creates
  /// config.md.
  legacy?: string
}

interface TableSpec {
  table: string
  title: string
  keys: KeySpec[]
}

interface MapSpec {
  table: string
  title: string
  value_type: 'chord' | 'color' | 'emoji'
  doc: string
  legacy?: string
}

interface ThemeTokenSpec {
  key: string
  type?: string
  values?: string[]
  envy?: string
  doc: string
}

interface Schema {
  version: number
  tables: TableSpec[]
  maps: MapSpec[]
  theme_tokens: {
    doc: string
    meta: ThemeTokenSpec[]
    colors: ThemeTokenSpec[]
  }
}

/// The schema as typed data. The JSON import is inferred as a wall of literal
/// types, which is precise but useless here — every consumer wants the shape,
/// not the exact string "compact".
export const schema = schemaJson as unknown as Schema

/// `table.key`, or just `key` for the root table — the flat name a setting is
/// addressed by everywhere in this file.
function qualify(table: string, key: string): string {
  return table ? `${table}.${key}` : key
}

const KEYS = new Map<string, KeySpec & { table: string }>()
for (const table of schema.tables) {
  for (const spec of table.keys) {
    const name = qualify(table.table, spec.key)
    KEYS.set(name, { ...spec, table: table.table })
  }
}

const MAPS = new Map<string, MapSpec>(schema.maps.map((m) => [m.table, m]))

// --- The in-memory config ----------------------------------------------------

/// Exactly what Rust returns from `config_load` / `config_set` and sends with
/// `config-changed`.
export interface ConfigDto {
  path: string
  values: Record<string, unknown>
  problems: string[]
  fresh: boolean
}

/// The toml fence as written, nested table → object. Missing keys mean
/// defaults; this is deliberately not defaults-filled, so "was it written
/// down?" stays answerable.
let values: Record<string, unknown> = {}
let problems: string[] = []
let path = '~/.config/envy/config.md'
/// False when the backend has no config commands (an older build, or a plain
/// browser). Everything still works off the schema defaults; nothing is
/// written back, because there is nowhere to write it.
let backed = false
let warned = false

type ChangeListener = (local: boolean) => void
const listeners: ChangeListener[] = []

/// Told when anything changes: `local` is true for a change this window just
/// made (the control that made it has already run its own side effect) and
/// false for one that arrived from the file, which is the case that has to
/// re-apply everything.
export function onChange(cb: ChangeListener) {
  listeners.push(cb)
}

function notify(local: boolean) {
  for (const cb of listeners) {
    try {
      cb(local)
    } catch (err) {
      console.error('a config listener threw', err)
    }
  }
}

function warnOnce(err: unknown) {
  if (warned) return
  warned = true
  console.warn('config.md is not available; using defaults for this session', err)
}

// --- Reading -----------------------------------------------------------------

function rawValue(table: string, key: string): unknown {
  if (!table) return values[key]
  const t = values[table]
  return t && typeof t === 'object' ? (t as Record<string, unknown>)[key] : undefined
}

/// A written-down value coerced to the schema's type, or null when it cannot
/// be. `problem` describes what was wrong, for the footer and the console.
function coerce(spec: KeySpec, raw: unknown): { value: ConfigValue | null; problem?: string } {
  const name = spec.key
  switch (spec.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' }
      return { value: null, problem: `${name} should be true or false` }
    }
    case 'int':
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { value: null, problem: `${name} should be a number` }
      const rounded = spec.type === 'int' ? Math.round(n) : n
      if (spec.min !== undefined && rounded < spec.min) {
        return { value: spec.min, problem: `${name} is below ${spec.min}` }
      }
      if (spec.max !== undefined && rounded > spec.max) {
        return { value: spec.max, problem: `${name} is above ${spec.max}` }
      }
      return { value: rounded }
    }
    case 'enum': {
      if (typeof raw === 'string' && (spec.values ?? []).includes(raw)) return { value: raw }
      return {
        value: null,
        problem: `${name} should be one of ${(spec.values ?? []).join(', ')}`,
      }
    }
    // A theme names one of the built-in faces *or* a file in themes/, so any
    // string is legal here; a name with no file behind it falls back to the
    // Envious face when the theme is resolved rather than being an error.
    case 'theme':
    case 'path':
    case 'string': {
      if (typeof raw === 'string') return { value: raw }
      return { value: null, problem: `${name} should be text` }
    }
  }
}

function spec(table: string, key: string): KeySpec & { table: string } {
  const found = KEYS.get(qualify(table, key))
  // A typo in a call site is a programming error, not a user's problem — and
  // silently returning undefined would make it look like a missing setting.
  if (!found) throw new Error(`no such setting: ${qualify(table, key)}`)
  return found
}

/// The current value of a setting: what the file says if it says anything
/// usable, otherwise the schema's default.
export function get(table: string, key: string): ConfigValue {
  const s = spec(table, key)
  const raw = rawValue(table, key)
  if (raw === undefined || raw === null) return s.default
  return coerce(s, raw).value ?? s.default
}

export function getBool(table: string, key: string): boolean {
  return get(table, key) === true
}

export function getNumber(table: string, key: string): number {
  const v = get(table, key)
  return typeof v === 'number' ? v : Number(v)
}

export function getString(table: string, key: string): string {
  const v = get(table, key)
  return typeof v === 'string' ? v : String(v)
}

/// One of the map tables (`shortcuts`, `tag_colors`, `folder_colors`,
/// `domain_emojis`) as a plain object. Anything in it that isn't text is
/// dropped rather than handed on — the callers all expect strings.
export function map(table: string): Record<string, string> {
  const raw = values[table]
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function configPath(): string {
  return path
}

export function configProblems(): string[] {
  return problems
}

// --- Writing -----------------------------------------------------------------

function setLocal(table: string, key: string, value: unknown) {
  if (!table) {
    if (value === null) delete values[key]
    else values[key] = value
    return
  }
  const t = (values[table] ?? {}) as Record<string, unknown>
  if (value === null) delete t[key]
  else t[key] = value
  values[table] = t
}

/// Sends a nested patch to Rust, which merges it into the fence keeping
/// comments and ordering. A JSON null deletes the key. Failure is logged and
/// swallowed: the in-memory value has already changed, so the app behaves as
/// asked even when the file cannot be written.
function writeThrough(patch: Record<string, unknown>) {
  if (!backed) return
  void invoke<ConfigDto>('config_set', { values: patch })
    .then((dto) => {
      path = dto.path
      problems = dto.problems
    })
    .catch((err) => console.error('could not write config.md', err))
}

function patchFor(table: string, key: string, value: unknown): Record<string, unknown> {
  return table ? { [table]: { [key]: value } } : { [key]: value }
}

/// Changes one setting and writes it to the file. The value is validated
/// against the schema first, so a control can never write something the file
/// would then report as a problem.
export function set(table: string, key: string, value: ConfigValue) {
  const s = spec(table, key)
  const { value: clean, problem } = coerce(s, value)
  if (clean === null) {
    console.error(`refusing to save an invalid ${qualify(table, key)}: ${problem}`)
    return
  }
  setLocal(table, key, clean)
  writeThrough(patchFor(table, key, clean))
  notify(true)
}

/// Adds, changes or (with `null`) removes one entry of a map table.
export function setMapEntry(table: string, key: string, value: string | null) {
  setMapEntries(table, { [key]: value })
}

/// The same, for the cases that change several entries at once — assigning
/// colors to a batch of new folders, or re-keying them after a rename. One
/// write rather than one per entry, so the file is never briefly half-updated.
export function setMapEntries(table: string, entries: Record<string, string | null>) {
  if (!MAPS.has(table)) throw new Error(`no such map table: ${table}`)
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entries)) {
    setLocal(table, key, value)
    patch[key] = value
  }
  writeThrough({ [table]: patch })
  notify(true)
}

// --- Validation --------------------------------------------------------------

const HEX_COLOR = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/// Everything wrong with the file, in the order a reader would meet it.
/// Unknown keys and bad values are reported, never fatal: a config that is
/// half nonsense still runs, with the nonsense parts on their defaults.
///
/// Rust validates the same schema, and its list is the one
/// `envynote config check` prints — so this only runs when Rust found
/// nothing, where it is a backstop rather than a second opinion nobody asked
/// for. Two validators describing one fault in two wordings would just make
/// the footer twice as long.
function validate(): string[] {
  const found: string[] = []
  const tables = new Set(schema.tables.map((t) => t.table).filter(Boolean))
  for (const [name, raw] of Object.entries(values)) {
    const isTable = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    if (isTable && MAPS.has(name)) {
      found.push(...validateMap(name, raw as Record<string, unknown>))
      continue
    }
    if (isTable) {
      if (!tables.has(name)) {
        found.push(`unknown section [${name}]`)
        continue
      }
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        found.push(...validateKey(name, key, value))
      }
      continue
    }
    found.push(...validateKey('', name, raw))
  }
  return found
}

function validateKey(table: string, key: string, value: unknown): string[] {
  const s = KEYS.get(qualify(table, key))
  if (!s) return [`unknown key ${qualify(table, key)}`]
  const { problem } = coerce(s, value)
  return problem ? [problem] : []
}

function validateMap(table: string, entries: Record<string, unknown>): string[] {
  const kind = MAPS.get(table)!.value_type
  const found: string[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string' || value === '') {
      found.push(`${table}.${key} should be text`)
      continue
    }
    if (kind === 'color' && !HEX_COLOR.test(value)) {
      found.push(`${table}.${key} should be a color like "#7aa2f7"`)
    }
  }
  return found
}

// --- The one-off migration ---------------------------------------------------

/// Reads a legacy `localStorage` value back into the type the schema says it
/// is. The old store held everything as text, so "false" and "0.9" have to
/// become a boolean and a number on the way in.
function fromLegacy(s: KeySpec, raw: string): ConfigValue | null {
  if (s.type === 'bool') return raw === 'true'
  if (s.type === 'int' || s.type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    return coerce(s, n).value
  }
  return coerce(s, raw).value
}

/// Colors were stored with the leading `#`; the schema's examples write them
/// with one too, so keep it and only add it if an older value lost it.
function normalizeColor(value: string): string | null {
  if (!HEX_COLOR.test(value)) return null
  return value.startsWith('#') ? value : `#${value}`
}

/// Everything this machine had chosen before config.md existed, as one patch.
/// Only keys that were actually set are included — an unset key means "the
/// default", and writing the default down would turn a default into a decision.
function collectLegacy(): { patch: Record<string, unknown>; keys: string[] } {
  const patch: Record<string, unknown> = {}
  const keys: string[] = []

  for (const s of KEYS.values()) {
    // `file:` legacies are files Rust owns (the index path, keep-on-top); it
    // migrates those itself before the webview is up.
    if (!s.legacy || s.legacy.startsWith('file:')) continue
    const raw = localStorage.getItem(s.legacy)
    if (raw === null) continue
    keys.push(s.legacy)
    const value = fromLegacy(s, raw)
    if (value === null) continue
    if (s.table) {
      const t = (patch[s.table] ?? {}) as Record<string, unknown>
      t[s.key] = value
      patch[s.table] = t
    } else {
      patch[s.key] = value
    }
  }

  for (const m of MAPS.values()) {
    if (!m.legacy) continue
    const raw = localStorage.getItem(m.legacy)
    if (raw === null) continue
    keys.push(m.legacy)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const entries: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v) continue
      const clean = m.value_type === 'color' ? normalizeColor(v) : v
      if (clean) entries[k] = clean
    }
    if (Object.keys(entries).length > 0) patch[m.table] = entries
  }

  return { patch, keys }
}

/// Folds the old `localStorage` preferences into the file Rust has just
/// created, then forgets them. Runs once, on the launch that first makes
/// config.md: after that the file is the truth and the old store would only be
/// a second, silently diverging copy.
async function migrateLegacy() {
  const { patch, keys } = collectLegacy()
  if (keys.length === 0) return
  if (Object.keys(patch).length > 0) {
    try {
      const dto = await invoke<ConfigDto>('config_set', { values: patch })
      values = dto.values
      path = dto.path
    } catch (err) {
      // The old values are still in localStorage, so the next launch tries
      // again — don't drop them on the floor by clearing them anyway.
      console.error('could not migrate the old settings into config.md', err)
      return
    }
  }
  for (const key of keys) localStorage.removeItem(key)
}

// --- Startup -----------------------------------------------------------------

let ready: Promise<void> | null = null

/// Loads config.md and starts following it. Safe to call from every window and
/// as many times as you like: the first call does the work and the rest wait
/// on it, which is what lets `initAppearance` depend on the config without the
/// boot path having to order the two by hand.
export function initConfig(): Promise<void> {
  ready ??= load()
  return ready
}

async function load() {
  let dto: ConfigDto
  try {
    dto = await invoke<ConfigDto>('config_load')
  } catch (err) {
    // No config commands behind us. Fall back to whatever this machine chose
    // before the file existed, so an older backend looks like it always did
    // rather than like a factory reset; nothing is written back, because there
    // is nowhere to write it.
    warnOnce(err)
    values = collectLegacy().patch
    return
  }
  backed = true
  values = dto.values ?? {}
  path = dto.path
  if (dto.fresh) await migrateLegacy()
  problems = dto.problems?.length ? dto.problems : validate()
  if (problems.length > 0) console.warn('config.md:', ...problems)

  try {
    await listen<ConfigDto>('config-changed', (event) => {
      values = event.payload.values ?? {}
      path = event.payload.path
      problems = event.payload.problems?.length ? event.payload.problems : validate()
      if (problems.length > 0) console.warn('config.md:', ...problems)
      notify(false)
    })
  } catch (err) {
    // Outside Tauri: the values loaded above still apply, they just won't
    // follow the file.
    warnOnce(err)
  }
}
