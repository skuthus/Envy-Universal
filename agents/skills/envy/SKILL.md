---
name: envy
description: >
  REQUIRED for configuring Envy, the flat-file note-taking app (package and
  binary: envynote). Use when editing ~/.config/envy/config.md or
  ~/.config/envy/themes/, or when the request touches Envy's settings, note
  list, editor, vault or notes folder, Inbox, trash sweep, Kindle import,
  keyboard shortcuts, colors or theme. Triggers: Envy, envynote,
  config.md, ~/.config/envy, Envy theme, Envy settings, Envy shortcuts, Envy
  vault, tag colors, folder colors. Excludes developing Envy itself.
---

# Envy Skill

Configure [Envy](https://envynote.app), a flat-file note-taking app: one search
box, instant results, notes as plain `.md` files. This skill is for an
installed Envy on a user's machine.

Every setting Envy has, and every color it uses, lives in a file you can read
and edit. The Settings panel writes the same files, so the two never disagree.

## When This Skill MUST Be Used

**ALWAYS invoke this skill for requests involving ANY of these:**

- Editing `~/.config/envy/config.md` or anything in `~/.config/envy/themes/`
- Any Envy setting: the notes folder, subfolder indexing, the note list
  (density, preview, dates, sorting), the editor, the Inbox, the footer clock,
  trash sweeping, updates, autostart, keep on top, Kindle import
- Envy keyboard shortcuts, or re-binding one
- Envy colors: a theme, a tag color, a folder color, making Envy match an
  Omarchy theme
- The `envynote config` and `envynote theme` commands

**If you are about to edit a file under `~/.config/envy/`, stop and read this
skill first.**

Do NOT use this skill to develop Envy itself (the `Envy-Linux` repo, its
Rust crates or its TypeScript frontend). That work follows the repo's own
`PLAN.md` and `AGENTS.md`.

## The Two Files

Both are markdown with exactly one ` ```toml ` fence. The fence holds the
settings. The prose around it is yours; Envy preserves it, and it is there so
the file reads well when you open it inside Envy itself.

### `~/.config/envy/config.md`

Every setting. Created on first launch with the defaults.

````markdown
# Envy settings

Edit here or in Settings; both stay in sync.

```toml
vault = "~/Documents/Envy"

[list]
density = "compact"

[shortcuts]
newFromTemplate = "Ctrl+N"
```
````

A key you leave out keeps its default. Tables are `[list]`, `[editor]`,
`[appearance]` and so on; every key, its type and its default are in
[`settings.md`](settings.md).

### `~/.config/envy/themes/<name>.md`

One theme per file, same shape: a toml fence of color tokens, then a sample
note as the body so that opening the file in Envy previews the theme. The
theme's name is the file stem, lowercase with dashes. See
[`theming.md`](theming.md).

## Critical Safety Rules

**NEVER edit anything under `/usr/share/envy/`.** That is the installed
package, replaced on the next update, and this skill's own copy lives there.
Reading it is fine and useful.

**Only edit inside the toml fence.** The prose above and below it is the
user's, and Envy keeps it. Do not rewrite the file, do not reorder or strip
comments inside the fence, and do not add keys that are not in
[`settings.md`](settings.md). Change the lines you were asked to change and
leave everything else alone.

**Never write a key Envy does not know.** An unknown key or a bad value is
reported, not fatal, so a typo does not break Envy. It also does nothing,
silently, until someone runs the check. Check the reference first.

**Always run `envynote config check` after editing `config.md`.** It parses
the file, validates it against the schema, prints one problem per line and
exits non-zero if there are any. It works whether or not Envy is running.
After editing a theme file, run `envynote theme check`: it validates every
theme file the same way and exits non-zero on a problem.

```bash
envynote config check
```

**Changes apply live.** Envy watches the config and themes directories. A save
re-applies within a moment, and there is nothing to restart. Do not tell the
user to restart Envy.

## Commands

```bash
envynote config check          # validate config.md; exit 1 on problems
envynote config path           # print the config file path
envynote config edit           # open config.md in Envy (needs Envy running)
envynote theme list            # theme file names, one per line, problems indented under each
envynote theme check           # validate every theme file; exit 1 on problems
envynote theme export <name>   # write the theme in use now to themes/<name>.md
```

`theme export` and `config edit` talk to the running app over its control
socket, so they fail when Envy is not running. The other two do not.

## The Current Omarchy Theme

Envy follows the current Omarchy theme by default. The slug of that theme is
the trimmed contents of one file:

```bash
cat ~/.local/state/omarchy/current/theme.name    # e.g. tokyo-night
```

That slug is the name to use for a theme file that should only apply while that
Omarchy theme is current. See [`theming.md`](theming.md).

## Topic Guides

Read the matching guide before starting:

- [`settings.md`](settings.md) - every key of `config.md`: type, default and
  meaning. Generated from the schema, so it is never out of date.
- [`shortcuts.md`](shortcuts.md) - every re-bindable action, its id, its
  default chord, and how a chord is spelled.
- [`theming.md`](theming.md) - theme files, every color token, how a theme
  overlays the one underneath it, and how to keep text readable.

## Worked Examples

**"Make Envy's list denser."** `list.density` is the row height, and the
preview line and date column are what else takes space. `compact` is already
the default, so the honest change is the columns:

```toml
[list]
density = "compact"
show_preview = false
show_date = false
```

Then `envynote config check`.

**"Put new notes in the Inbox and show me the count."**

```toml
[list]
inbox_enabled = true
new_notes_in_inbox = true
```

**"Give my #work tag a blue."**

```toml
[tag_colors]
work = "#7aa2f7"
```

**"Make an Envy theme for my current Omarchy theme with a warmer link color."**
Find the slug, then write a theme file named after it holding only the tokens
you want to change. Envy derives the rest from the Omarchy palette, so a
partial file is the point:

```bash
cat ~/.local/state/omarchy/current/theme.name    # tokyo-night
```

`~/.config/envy/themes/tokyo-night.md`:

````markdown
# Tokyo Night, warmer links

```toml
mode = "dark"
link = "#e0af68"
```

A sample note so this file previews the theme when opened in Envy.
````

```bash
envynote theme list
envynote config check
```

Nothing else changes: `appearance.theme` stays `omarchy`, and the file is
picked up because its name matches the Omarchy slug. If the user wants a
starting point with every color spelled out instead, run
`envynote theme export tokyo-night` first and edit what it wrote.

**"Change the summon hotkey."** That one is not Envy's to change on Wayland.
See the global shortcuts section of [`shortcuts.md`](shortcuts.md).

## Out of Scope

- Editing `/usr/share/envy/` (the installed package, including this skill)
- Building or modifying Envy's source
- Writing notes into the vault: that is what the app is for, and the file
  layout of a note is the app's contract, not a setting
