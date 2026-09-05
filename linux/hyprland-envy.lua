-- Envy on Hyprland (Omarchy Lua config).
--
-- Ctrl+Alt+Return (the same chord as Envy for Windows) shows Envy if it is
-- hidden and hides it if it is showing — exactly the bar icon's click — and
-- launches it if it isn't running. Wayland has no app-registered global
-- hotkeys, so this bind *is* the summon; it runs `envynote --toggle`, which
-- hands the verb to the running instance over its control socket.
--
-- Install: append to ~/.config/hypr/bindings.lua one of
--   pcall(dofile, "/usr/share/envy/hyprland-envy.lua")                                -- package
--   pcall(dofile, os.getenv("HOME") .. "/Work/Envy-omarchy/linux/hyprland-envy.lua")  -- checkout
-- then `hyprctl reload`.

-- The summon script sits next to this file, wherever this file lives.
local here = (debug.getinfo(1, "S").source:sub(2)):match("(.*/)") or "./"
local envy_summon = here .. "envy-summon.sh"

-- Match on class AND title: pop-out notes and the pinned popover share the
-- `envynote` class, and those should stay ordinary windows.
o.window({ class = "envynote", title = "^Envy$" }, {
  float = true,
  -- The owner's chosen default: about a third of the screen wide and most
  -- of it tall (507x739 on a 1440x900 display).
  size = { "(monitor_w*0.35)", "(monitor_h*0.82)" },
  center = true,
})

-- Omarchy's default window opacity (0.985 / 0.96) multiplies every glyph.
-- Drop it so Envy can be as sharp as an opaque terminal.
o.window("envynote", {
  tag = "-default-opacity",
  opacity = "1 override 1 override 1 override",
})

o.bind("CTRL + ALT + RETURN", "Envy", envy_summon)
-- Drag it around, then bring it back: centres whichever floating window has
-- focus, so it serves any floating window, Envy included.
o.bind("CTRL + ALT + C", "Centre the floating window", hl.dsp.window.center())
