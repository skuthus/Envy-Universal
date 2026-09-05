# Envy Themes and Colors

Read this before changing any Envy color.

## How a Theme Is Chosen

One setting decides: `appearance.theme` in `~/.config/envy/config.md`.

| Value | What Envy shows |
| --- | --- |
| `omarchy` (default) | Colors derived from the current Omarchy theme's `colors.toml`, retinted whenever `omarchy theme set` runs |
| `system` | The Envious palette, dark or light following the desktop preference |
| `dark` / `light` | The Envious palette, pinned to that face |
| any other value | The theme file `~/.config/envy/themes/<value>.md`, laid over the Envious face named by its `mode` |

There is one extra rule, and it is the useful one. In `omarchy` mode, if a
theme file is named after the **current Omarchy theme's slug**, Envy lays it
over the derived colors automatically. So a file called `tokyo-night.md`
tweaks Envy while Tokyo Night is the Omarchy theme, and stops applying by
itself when the user switches away. Nothing in `config.md` has to change.

Find the slug:

```bash
cat ~/.local/state/omarchy/current/theme.name    # tokyo-night
```

It is the theme's directory name. Aether-generated themes have a numeric id
there instead; that is still a valid file name.

Envy re-checks for the override file on every Omarchy theme change and every
time the themes directory changes, so a file added later takes effect at once.

## A Theme File

`~/.config/envy/themes/<name>.md`. The name is the file stem, lowercase with
dashes and digits. One ` ```toml ` fence, then a body that is an ordinary note.
The body exists so that opening the file inside Envy previews the theme: give
it a heading, a list, a task, a link, a tag, some code, a quote, a highlight
and a footnote, and every token has something on screen to color.

**Every color is optional.** A token you leave out is filled in from the face
underneath: the Omarchy-derived colors in `omarchy` mode, otherwise Envious
dark or light per `mode`. Write only the tokens you mean to change.

````markdown
# Tokyo Night, warmer links

```toml
mode = "dark"
link = "#e0af68"
due_soon = "#e0af68"
```

A sample note.

- A list item with a [link](https://envynote.app) and a #tag
- [ ] An open task
- [x] A finished one

> A quote, some `inline code` and ==a highlight==.[^1]

[^1]: A footnote.
````

### Meta keys

| Key | Meaning |
| --- | --- |
| `mode` | `dark` or `light`. Which Envious face this theme overlays, and whether Envy treats itself as dark. Always set it. |
| `font` | Optional fontconfig family. Left out, the `appearance.font` setting decides. |
| `font_size` | Optional CSS size for the editor, for example `"15px"`. |

### Color tokens

Colors are `#rrggbb` or `#rrggbbaa`.

| Token | What it paints |
| --- | --- |
| `text` | Body text |
| `background` | Editor background |
| `marker` | Markdown syntax marks: `#`, `*`, `-`, backticks |
| `link` | Links and wiki-links |
| `due` | A due date that is not close |
| `due_soon` | A due date within a few days |
| `due_overdue` | A due date in the past |
| `code_background` | Inline code and fenced blocks |
| `tag` | Tag text |
| `tag_background` | The tag pill behind it |
| `highlight` | The `==highlighted==` background |
| `highlight_text` | Ink on that highlight |
| `flag` | The vivid accent, used for the Inbox badge |
| `selection` | The selected row in the note list |
| `selected_text` | The editor's text-selection background |
| `focus_highlight` | The keyboard focus ring |
| `file_list_background` | Note list and search box |
| `blockquote` | Blockquote text, and mixed into the footer and chrome text |
| `completed_task` | A checked task's text |
| `footnote` | Footnote markers and text |
| `checked_checkbox` | The checked box glyph |
| `title_bar_background` | The note title bar |

## Recipes

### Tweak the current look, keep everything else

Write a partial file. In `omarchy` mode name it after the Omarchy slug; in any
other mode name it whatever you like and point `appearance.theme` at it.

```bash
cat ~/.local/state/omarchy/current/theme.name    # tokyo-night
$EDITOR ~/.config/envy/themes/tokyo-night.md     # mode + the tokens to change
envynote theme check                           # the file parses and every token is valid
envynote config check                          # config.md is still valid
```

### Start from what is on screen and edit it

```bash
envynote theme export midnight     # writes ~/.config/envy/themes/midnight.md
```

That writes the theme Envy is showing right now, fully resolved: every token,
whether it came from Omarchy, from the Envious palette, or from an overlay
already in place. It needs Envy to be running. Edit the file, then select it:

```toml
[appearance]
theme = "midnight"
```

An exported file is a complete theme, so it no longer follows the Omarchy
theme. That is the trade: a fixed look you fully control, instead of one that
tracks the desktop. Prefer a partial file named after the slug unless the user
asked for a theme of their own.

### A light theme and a dark theme

Two files, two `mode` values. `appearance.theme` names one of them at a time;
there is no automatic pairing.

## Where the Omarchy Colors Come From

In `omarchy` mode Envy reads the current theme's `colors.toml` and maps a
terminal palette onto note roles. Knowing the mapping tells you which Omarchy
color to blame when something looks wrong, and which Envy token to override
instead of editing the Omarchy theme.

| Omarchy key (first that exists) | Envy tokens |
| --- | --- |
| `background`, `bg` | `background` |
| `dark_background`, `dark_bg`, `darker_background` (else `background`) | `file_list_background`, `title_bar_background` |
| `lighter_background`, `lighter_bg` | `code_background` |
| `foreground`, `fg` | `text` |
| `bright_foreground`, `bright_fg`, `light_foreground` (else `foreground`) | `due` |
| `muted`, `dark_foreground`, `dark_fg` | `marker` |
| `dark_foreground`, `dark_fg` (else the muted color) | `blockquote`, `completed_task`, `footnote` |
| `accent`, `blue` | `link`, `selection`, `focus_highlight` |
| `red` | `due_overdue`, `selected_text` |
| `green` | `tag`, `tag_background`, `checked_checkbox` |
| `yellow` | `due_soon`, `highlight` |
| `bright_magenta`, `magenta` (else `yellow`) | `flag` |

`highlight_text` is not taken from a key. Envy picks whichever of the dark
background and the foreground reads better on the highlight color, then
darkens or lightens it until it is legible.

Two things happen to those colors on the way in.

**Fills get alpha.** `background`, `file_list_background`,
`title_bar_background` and `code_background` are made slightly translucent
(roughly 0.88 to 0.94, and 0.72 to 0.82 for code) so Hyprland's blur shows
through the window. Tinted fills built from a palette color, `selection`,
`tag_background`, `focus_highlight` and `selected_text`, are the theme's own
color at a low alpha rather than the color itself.

**Text gets a contrast floor.** See below.

## Contrast Floors

Omarchy themes are written for terminals and window borders, where a dim
`muted` is a design choice. Envy renders paragraphs in those roles at a small
size, so it enforces two floors, measured as WCAG contrast against both the
editor background and the note list background:

- **4.5:1** for anything carrying text: `text`, `link`, `tag`, `due`,
  `due_soon`, `due_overdue`, `blockquote`, `completed_task`, `footnote`,
  `flag`. `highlight_text` is held to the same ratio, but against
  `highlight`, the only surface it ever sits on.
- **2.4:1** for `marker`. Syntax marks are meant to recede. They only have to
  be visible.

For an Omarchy-derived color the floor is applied for you: the hue is kept and
the color is nudged toward white or black by the smallest amount that clears
the floor, so a theme that already reads well is left untouched.

For a color **you** write in a theme file it is not. Your color is used
exactly as written, and if it fails a floor Envy names the token in the footer
status line instead of quietly changing it. A color you chose is a decision,
and a warning is more useful than a color you did not pick.

So pick colors that pass. Rules of thumb on a dark background: a mid-tone at
around 60% lightness usually clears 4.5:1, a color near the background's
lightness never does. On a light background, go darker rather than more
saturated. To be sure, compute it rather than guess:

```bash
node -e '
const c = (h) => { const n = parseInt(h.slice(1),16)
  const ch = (v) => { v/=255; return v<=0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4 }
  return 0.2126*ch(n>>16&255) + 0.7152*ch(n>>8&255) + 0.0722*ch(n&255) }
const ratio = (a,b) => { const [x,y]=[c(a),c(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05) }
console.log(ratio("#e0af68", "#1a1b26").toFixed(2))'
```

Anything at or above 4.5 is safe for text, 2.4 for markers.

If you also darken or lighten `background` or `file_list_background` in the
same file, check the text tokens against the new background, not the old one.

## Rules

- Never edit `/usr/share/envy/`, and never edit an Omarchy theme under
  `/usr/share/omarchy/themes/`. To change Envy's colors, write an Envy theme
  file. To change Omarchy's, see the `omarchy` skill.
- One ` ```toml ` fence per file. Keep the body, keep any comments.
- Run `envynote config check` after editing `config.md`. After editing a
  theme file, `envynote theme check` validates it (`theme list` also prints
  each file's problems under its name), and a token that misses a contrast
  floor is named in Envy's footer status line once the theme is in use.
- A theme change applies live. Nothing needs restarting.
