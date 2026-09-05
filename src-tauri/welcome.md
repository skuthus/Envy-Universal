# Welcome to Envy

Envy is one search box over a folder of plain Markdown files. Type to filter
your notes, then press Return: it opens the note with exactly that title, or
creates one from whatever you typed. That is the whole idea; everything below
is detail.

This note is an ordinary note. Edit it, delete it, or keep it as a cheat
sheet. Press **Ctrl+/** at any time for the built-in reference (markup,
shortcuts, emoji), and **Ctrl+,** for Settings.

## Your notes are files

- Every note is a `.md` file in one folder Envy calls **The Index**. Change
  where it lives in Settings, or point other apps, sync tools and agents at
  it. There is no database and nothing to export.
- The first line of a note is its title. Rename the file and the title
  follows; rename the title and the file follows.
- Subfolders are fine. With "include subfolders" on (the default), a note's
  folder shows as a colored dot in the list, and **Ctrl+Shift+M** moves the
  open note somewhere else.
- A few folders inside The Index have jobs: `Inbox/` holds quick captures,
  `Templates/` holds templates, `Attachments/` holds images, and `.trash/`
  holds what you delete until it is swept.

## Search, then Return

The search box is where everything starts. **Escape** jumps back to it from
anywhere (closing whatever is open first, one layer per press), and
**Alt+Backspace** clears it.

- Words match anywhere in a note. `"a phrase"` in quotes matches those words
  together.
- Separate alternatives with a comma: `meeting, standup` finds either.
- Everything else within one query narrows: `project tag:work due:week`.
- Put `-` in front of a term or an operator to exclude it: `-tag:done`.
- Return opens the note whose title is exactly what you typed. Otherwise it
  creates a new note with that title, even when other notes match the words;
  the line under the list says which it is about to do. Arrow down to open a
  partial match instead. Type `inbox: some words` and Return to capture a
  fleeting note in the Inbox without leaving where you are.

### Operators

| Operator | Finds |
| --- | --- |
| `tag:name` | Notes carrying `#name` (partial match; quote it for exact). Bare `tag:` is any tagged note, `-tag:` untagged ones. |
| `title:word` | Word in the title only. |
| `folder:name` | Notes in that folder or below. Bare `folder:` is any note in a subfolder, `-folder:` only the root. |
| `due:today` | Also `due:tomorrow`, `due:week`, `due:month`, `due:overdue`, an exact date, or bare `due:` for anything with a date. |
| `date:week` | Edited in the last week; also `today`, `yesterday`, `month`. |
| `stale:90` | Not edited for 90 days; also `stale:month`, `stale:year`. |
| `todo:` | Has an unchecked task. `-todo:` has none. |
| `link:Title` | Links to that note. `interlink:Title` is linked in either direction. |
| `linked:` / `orphan:` | Has links / nothing links to it. |
| `ghost:` | Contains a `[[link]]` to a note that does not exist yet. |
| `img:` / `embed:` | Contains an image / embeds another note. |
| `inbox:` | Fleeting notes in the Inbox. `-inbox:` hides them. |
| `ai:` | Notes signed by an agent (`⎈ created by …` or `⎈ edited by …`); `ai:created` and `ai:edited` narrow it. |

Combine them for a tidy-up sweep: `-tag: orphan: stale:year` is every
untagged note nothing links to that has not been touched in a year.

## Moving around

Envy is built for the keyboard. Arrow keys and **j** / **k** move in any
list, Return opens, Escape backs out one step.

- **Alt+Down** / **Alt+Up** cycle focus between the search box, the list and
  the editor.
- Click a column header to sort by name, date or due; click again to flip
  the direction.
- **Ctrl+Shift+L** switches between the list above the note and beside it.
- **Ctrl+=** / **Ctrl+-** / **Ctrl+0** zoom the editor.
- **Ctrl+Alt+P** pins a note into a strip under the list header, so it stays
  in reach however far the list scrolls. **Ctrl+Shift+O** pops the open note
  out into its own window.
- **Ctrl+\** splits the editor into two panes and closes the split again;
  **Alt+\** hops between them and **Ctrl+Alt+\** flips them between side
  by side and stacked. Right-click a note in the list → **Send to Split
  Pane** opens it beside the one you are in. Drag the line between the panes
  to resize them; double-click it for an even split.

## Writing

Markdown renders as you type and stays plain text on disk. **Ctrl+Shift+P**
shows the raw text when you want it.

- `# Heading` through `###### Heading`.
- `**bold**` (**Ctrl+B**), `*italic*` (**Ctrl+I**), `~~struck~~`,
  `==highlighted==`, `` `code` ``.
- A fenced code block (three backticks) renders as a code panel until you
  click into it.
- `> quote`, `---` for a rule, `- item`, `1. item`.
- `- [ ] task` gives a checkbox. Click it, or press **Ctrl+Shift+D** on the
  line. Ticking a task retires any due date in it.
- Tables render as real tables with editable cells. Insert one with
  **Ctrl+Shift+T**, by typing `/table` and pressing Tab, or by pasting rows
  separated by tabs or commas. The toolbar above a table adds rows and
  columns and sets alignment.
- `text[^1]` and `[^1]: the note` make footnotes.
- `:smile:` becomes 😄 the moment you close the second colon, and `->`
  becomes an arrow. Ctrl+/ has the full shortcode list.
- Paste or drop an image, or press **Ctrl+Alt+I**, and Envy saves it to
  `Attachments/` and writes `![[name.png]]` for you.
- Select some text and press **Ctrl+Alt+N** to move it into a new note,
  leaving a link behind. **Ctrl+Shift+N** starts a note from a template.

### Links

- `[[Note Title]]` links to another note. **Ctrl+click** follows it and
  creates the note if it is missing. **Ctrl+Shift+Return** does the same from
  the keyboard.
- **Alt+click** peeks at the target in a floating preview you can drag by its
  title bar; **Alt+Return** does it from the keyboard. **Alt+Shift+click**
  opens the target in its own window.
- `[[Note Title|your words]]` shows your words instead of the title.
- `![[Note Title]]` on its own line embeds that note's live content. Click
  into it to edit the other note in place.
- Bare web addresses become clickable pills labelled with their domain.
  **Ctrl+Shift+E** on one gives that domain an emoji, which then shows on
  every link to it.
- The **Interlinks** panel under the note (**Ctrl+Shift+B**) lists every note
  that links here.

### Tags and due dates

- `#tag` anywhere in a note tags it. Tags get a color in Settings, and
  `tag:` finds them.
- `@04-16-26` or `@2026-04-16` is a due date. `@today`, `@tomorrow` and
  `@friday` work too, and turn into the real date as you finish typing so
  they never slide. Due dates show as an urgency-tinted pill in the editor,
  the title bar and the list.
- Click a due date to retire it (or **Ctrl+Shift+U**). A retired date stops
  matching `due:` searches; click again to bring it back.

## Inbox

The Inbox is a capture queue. `inbox: buy milk` and Return files a fleeting
note there. The count beside the search box says how many are waiting; click
it to review them, click again to come back. Move a note out of the Inbox to
file it, or turn the Inbox off in Settings to make it an ordinary folder.

## Templates

Any `.md` file in `Templates/` is a template. **Ctrl+Shift+N** lists them.
Inside a template, `{{title}}`, `{{date}}` and `{{time}}` are filled in when
a note is created from it; the date format is a Setting. The bar icon's menu
can also create a pinned note straight from a template.

## Trash

**Ctrl+Backspace** deletes the open note into `.trash/` inside The Index, and
**Ctrl+Shift+Backspace** brings the last one back. The trash is swept on the
schedule in Settings, or on demand from there.

## Summon it from anywhere

Envy is meant to be a panel you call up and dismiss, not a window you keep
finding.

- Turn on **Settings → System → Bind Ctrl+Alt+Return in Hyprland**. From
  then on **Ctrl+Alt+Return** shows or hides Envy from any app, and
  **Ctrl+Alt+C** centers it. It adds one line to
  `~/.config/hypr/bindings.lua` and removes it again when turned off.
- The eye in the Omarchy bar does the same on click. It appears while Envy
  runs; its menu can keep it there as a launcher when Envy is closed.
- "Envy is tiled" and "Pop-out notes are tiled" in Settings decide whether
  windows float as panels or tile like everything else. Keep Envy on Top, in
  the bar icon's menu, pins a floating Envy above every workspace.
- "Hide Envy when clicking outside the app" makes it vanish the moment you
  move on, and "Open Envy at login" starts it with your session.

## Pin a note to the bar

**Ctrl+Alt+T** pins the open note to the bar icon. Its menu then shows or
hides that one note in a small window, for a checklist or a scratchpad you
keep glancing at. Unpin it from the same menu.

## Settings and themes

Every setting lives in **`~/.config/envy/config.md`**, a Markdown file with
one TOML block. Settings and the file stay in sync: change either and the
other follows without a restart. Open it with **Settings → Config file →
Edit in Envy**, from a terminal with `envynote config edit`, or in any
editor.

- **Appearance → Theme** follows the current Omarchy theme by default, and
  switches when Omarchy does. `system`, `dark` and `light` use Envy's own
  palette instead.
- Themes are files too, one per `~/.config/envy/themes/<name>.md`. Export
  the live theme with `envynote theme export <name>`, adjust a color, and
  choose it in Settings. A file named after an Omarchy theme overrides just
  that one.
- The font follows Omarchy's monospace font unless you choose your own.
  Cascadia's cursive italics switch on by themselves; other OpenType
  features go in **Settings → Appearance → OpenType features**.
- `envynote config check` validates the file and prints any problem; the
  footer shows the same notice while a key is wrong.
- Envy never checks for updates on its own. **Settings → Updates → Check
  Now** looks up the latest release on GitHub and, if it is newer, opens a
  terminal with the update command.

### Let an agent do it

Envy links an **agent skill** into `~/.claude/skills/envy` and
`~/.agents/skills/envy` on launch. With it, an agent such as Claude Code knows
the config file, every key, and the theme format, so "make my links warmer"
or "hide the folder count in the footer" is a request rather than a search.
Notes an agent writes carry a `⎈ created by …` line, which `ai:` finds.

## Kindle highlights

Enable Kindle import in Settings, plug in a Kindle, and Import pulls every
highlight into the Inbox as one note each, titled by the quote's first words,
with the book as a `[[link]]`. Older Kindles mount as a drive; recent ones
connect over MTP, which the desktop reads directly, so both are detected. If
yours still isn't seen, copy its `My Clippings.txt` over and choose the file
instead. Envy remembers what it has imported, so re-importing only adds what
is new.

## Shortcuts at a glance

| Keys | Does |
| --- | --- |
| Escape | Jump to search |
| Alt+Backspace | Clear search |
| Alt+Down / Alt+Up | Next / previous area |
| Ctrl+Shift+N | New note from template |
| Ctrl+Alt+N | Extract selection to a new note |
| Ctrl+Backspace | Delete note |
| Ctrl+Shift+Backspace | Restore deleted note |
| Ctrl+Alt+P | Pin / unpin note |
| Ctrl+Alt+T | Pin note to the bar |
| Ctrl+Shift+O | Pop out note |
| Ctrl+\ | Split editor / close split |
| Alt+\ | Switch editor pane |
| Ctrl+Alt+\ | Flip split direction |
| Ctrl+Shift+M | Move to folder |
| Ctrl+B / Ctrl+I | Bold / italic |
| Ctrl+Alt+I | Insert image |
| Ctrl+Shift+T | Insert table |
| Ctrl+Shift+D | Toggle checkbox |
| Ctrl+Shift+Return | Follow link under cursor |
| Alt+Return | Peek at link under cursor |
| Ctrl+Shift+U | Retire / restore due date |
| Ctrl+Shift+E | Emoji for link |
| Ctrl+Shift+P | Plain-text mode |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| Ctrl+Shift+L | Toggle layout |
| Ctrl+Shift+B | Toggle interlinks |
| Ctrl+Return | Center window |
| Ctrl+, | Settings |
| Ctrl+/ | Markup and shortcut reference |
| Ctrl+Alt+Return | Show / hide Envy (Hyprland bind) |

Every one of these can be changed in **Settings → Shortcuts**.

## Try it now

- [ ] Type a word in the search box and press Return to make a note
- [ ] Link back here with `[[Welcome to Envy]]`
- [ ] Give it a `#tag` and a due date like `@friday`
- [ ] Search `tag:` to see it, then `due:week`
- [x] Read this far
