# Drive the real app on Windows and check what lands on disk.
#
# The Windows counterpart of gui-smoke.sh. Same shape, same assertions: it
# launches the app, then — through the window, as a user would — creates a
# note, edits it, opens and edits a template, and deletes the note. Every step
# is verified by what appears in the vault, not by what the script typed.
#
#   .\scripts\gui-smoke.ps1                 # dev build (npm run tauri dev)
#   .\scripts\gui-smoke.ps1 -Release        # target\release\envynote.exe
#   .\scripts\gui-smoke.ps1 -Release -BigVault [path]   # paging pass
#
# -Release is the only way to exercise the production CSP: the dev build uses
# devCsp. Build it with `npm run tauri build -- --no-bundle`.
#
# HOW THIS DIFFERS FROM THE LINUX SCRIPT, AND WHY
#
# gui-smoke.sh points the app at a throwaway config with XDG_CONFIG_HOME, so
# the owner's real config.md is never touched. That is not available here:
# config::dir() calls dirs::config_dir(), which on Windows resolves through
# SHGetKnownFolderPath(FOLDERID_RoamingAppData) and ignores %APPDATA%. There
# is no env var that redirects it.
#
# So this script edits the real config.md in place and restores it afterward.
# That is a bigger promise to keep, and the rails are built accordingly:
#   - the original is copied to config.md.smokebak before anything is touched
#   - restoration runs in a finally block, so it survives Ctrl+C and throws
#   - a leftover .smokebak from a crashed run aborts the script rather than
#     being overwritten, because that copy is the only good one left
#   - only the `vault` line is rewritten; every other setting is the owner's
#
# Needs: PowerShell 5.1+, node, npm, cargo. No jq (ConvertFrom-Json is native).
# It writes into the test vault, so it refuses to run unless that path
# contains "Test Vault" or -AllowAnyVault is passed.
#
# Not covered (same as Linux): the pinned-note and pop-out windows.

[CmdletBinding()]
param(
  [switch]$Release,
  [switch]$BigVault,
  [string]$BigVaultPath = $env:ENVY_BIG_VAULT,
  [string]$Out,
  [switch]$AllowAnyVault
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$mode = if ($Release) { 'release' } else { 'dev' }
$sub  = if ($BigVault) { "$mode-big" } else { $mode }
if (-not $Out) { $Out = Join-Path $env:TEMP 'envy-smoke' }
$shot = Join-Path $Out $sub
New-Item -ItemType Directory -Force -Path $shot | Out-Null
$log = Join-Path $shot 'dev.log'

$script:fails = 0
function pass($m) { Write-Host "  ok   $m" -ForegroundColor Green }
function fail($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:fails++ }

# --- Win32: window discovery, focus, screenshots -----------------------------
# Replaces hyprctl (find/geometry/focus) and grim (capture).
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EnvySmokeWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(
      IntPtr h, int attr, out RECT val, int size);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][EnvySmokeWin]::SetProcessDPIAware()

function Get-EnvyWindow {
  Get-Process envynote -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}

function Get-EnvyGeometry($h) {
  # DWMWA_EXTENDED_FRAME_BOUNDS (9), not GetWindowRect: since Vista the latter
  # includes an invisible resize border, so a capture of that rectangle carries
  # ~8px of whatever is behind the window down each side. That bleed would
  # corrupt any pixel assertion near an edge and skew the blank-check variance.
  $r = New-Object EnvySmokeWin+RECT
  $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([EnvySmokeWin+RECT]))
  if ([EnvySmokeWin]::DwmGetWindowAttribute($h, 9, [ref]$r, $size) -ne 0) {
    if (-not [EnvySmokeWin]::GetWindowRect($h, [ref]$r)) { return $null }
  }
  [pscustomobject]@{ X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; H = $r.Bottom - $r.Top }
}

# Hyprland reports focus failure by message rather than exit code, so the Linux
# script confirms by asking which window is active. Same idea here.
function Focus-Envy {
  $p = Get-EnvyWindow
  if (-not $p) { throw 'Envy window is gone' }
  for ($i = 0; $i -lt 5; $i++) {
    if ([EnvySmokeWin]::IsIconic($p.MainWindowHandle)) {
      [void][EnvySmokeWin]::ShowWindow($p.MainWindowHandle, 9)  # SW_RESTORE
    }
    [void][EnvySmokeWin]::SetForegroundWindow($p.MainWindowHandle)
    Start-Sleep -Milliseconds 300
    if ([EnvySmokeWin]::GetForegroundWindow() -eq $p.MainWindowHandle) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'could not focus the Envy window'
}

function Save-Shot($name) {
  $p = Get-EnvyWindow
  $g = Get-EnvyGeometry $p.MainWindowHandle
  $bmp = New-Object System.Drawing.Bitmap $g.W, $g.H
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($g.X, $g.Y, 0, 0, $bmp.Size)
  $path = Join-Path $shot "$name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $gfx.Dispose(); $bmp.Dispose()
  return $path
}

# --- Input: replaces wtype ---------------------------------------------------
# SendKeys treats + ^ % ~ ( ) { } [ ] as syntax, so literal text is escaped.
$wsh = New-Object -ComObject WScript.Shell
function Send-Literal($text) {
  $esc = [regex]::Replace($text, '[+^%~(){}\[\]]', '{$0}')
  $wsh.SendKeys($esc)
}
function Send-Key($keys) { $wsh.SendKeys($keys) }

function Search-For($query) {
  Send-Key '{ESC}';  Start-Sleep -Milliseconds 200
  Send-Key '%{BS}';  Start-Sleep -Milliseconds 200   # Alt+Backspace clears
  Send-Literal $query
  Start-Sleep -Milliseconds 800
  Send-Key '{ENTER}'
  Start-Sleep -Milliseconds 1200
}

# Return is a newline when the editor has focus, and "open the highlighted row,
# then focus the editor" when the search box has it. The second is async and the
# unoptimised dev build needs a moment, or the text lands in the search box and
# reaches no file at all.
function Append-Line($text) {
  Send-Key '^{END}'
  Send-Key '{ENTER}'
  Start-Sleep -Milliseconds 1200
  Send-Literal $text
  Start-Sleep -Seconds 3
}

# The app opens a note on every arrow press, so anything faster than ~15 keys/s
# queues up and the screenshot lags the input by seconds.
$keyDelay = 70
function Tap($k) { Send-Key $k; Start-Sleep -Milliseconds $keyDelay }

# Windows PowerShell 5.1's `-Encoding utf8` writes a BOM. A BOM in config.md
# breaks the TOML fence parser, and in a note it lands in the note's text and
# ahead of the `# Title` line. Everything written here goes through this.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8($path, [string[]]$lines) {
  [System.IO.File]::WriteAllLines($path, $lines, $utf8NoBom)
}

# --- Config isolation --------------------------------------------------------
$cfgDir  = Join-Path $env:APPDATA 'envy'
$cfgPath = Join-Path $cfgDir 'config.md'
$cfgBak  = Join-Path $cfgDir 'config.md.smokebak'
if (-not (Test-Path $cfgPath)) {
  throw "no Envy config at $cfgPath - launch Envy once first"
}
if (Test-Path $cfgBak) {
  throw "$cfgBak already exists - an earlier run did not finish. That copy is " +
        "your original config: restore it by hand (rename it to config.md), then re-run."
}

# --- Which vault ------------------------------------------------------------
if ($BigVault) {
  if (-not $BigVaultPath) { $BigVaultPath = Join-Path $env:LOCALAPPDATA 'envy-bench\vault20k' }
  if (-not (Test-Path $BigVaultPath)) {
    throw "no big vault at '$BigVaultPath' (pass -BigVaultPath or set ENVY_BIG_VAULT)"
  }
  $vault = $BigVaultPath
  $n = (Get-ChildItem $vault -File -ErrorAction SilentlyContinue).Count
  Write-Host "== big-vault mode: the app under test opens $vault ($n entries)"
} else {
  $vault = if ($env:ENVY_SMOKE_VAULT) { $env:ENVY_SMOKE_VAULT } else { Join-Path $HOME 'Envy Test Vault' }
  if (-not (Test-Path $vault)) {
    throw "no test vault at '$vault' - make one: node scripts/gen-test-vault.mjs"
  }
  if ($vault -notlike '*Test Vault*' -and -not $AllowAnyVault) {
    throw "'$vault' is not a test vault (its path lacks ""Test Vault""). Use one from " +
          "scripts/gen-test-vault.mjs, or pass -AllowAnyVault to run against it anyway."
  }
}

$mark = "smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
# The title carries the run marker so the search can only ever match this run's
# two notes. gui-smoke.sh uses a fixed "Smoke Test Note", which also matches any
# note left behind by an earlier run (or generated by gen-test-vault.mjs with
# those words in its title) — that only works because the list sorts
# newest-first and the fresh notes land on top. Not worth relying on.
$title = "Smoke Test $mark"
$note  = Join-Path $vault "$title.md"
$note2 = Join-Path $vault "$title 2.md"
$trash = Join-Path $vault ".trash\$title.md"
$template = $null
$image = $null
if (-not $BigVault) {
  $template = Get-ChildItem (Join-Path $vault 'Templates\*.md') -ErrorAction SilentlyContinue |
                Select-Object -First 1 -ExpandProperty FullName
  $image = Get-ChildItem (Join-Path $vault 'Attachments\*.png') -ErrorAction SilentlyContinue |
                Select-Object -First 1 -ExpandProperty Name
}
$templateBak = Join-Path $shot 'template.bak'
$proc = $null

try {
  # --- Pre-flight guards -----------------------------------------------------
  if (Get-Process envynote -ErrorAction SilentlyContinue) {
    throw 'Envy is already running; close it first'
  }
  if ($mode -eq 'dev') {
    $busy = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
    if ($busy) { throw 'port 1420 is busy - a stale vite from an earlier run?' }
  }
  if ($mode -eq 'release') {
    $bin = Join-Path $repo 'target\release\envynote.exe'
    if (-not (Test-Path $bin)) {
      throw "no release binary at $bin - build it: npm run tauri build -- --no-bundle"
    }
    $binTime = (Get-Item $bin).LastWriteTime
    $stale = Get-ChildItem src, src-tauri\src -Recurse -File |
             Where-Object { $_.LastWriteTime -gt $binTime } | Select-Object -First 1
    if ($stale) {
      throw "$bin is older than $($stale.FullName) - rebuild: npm run tauri build -- --no-bundle"
    }
  }

  # --- Point the config at the test vault ------------------------------------
  Copy-Item $cfgPath $cfgBak
  # `vault = "..."` is the first line of the TOML block; everything else is kept.
  $done = $false
  # Forward slashes, matching the form Envy itself writes: a TOML basic string
  # would otherwise need every backslash escaped.
  $vaultToml = $vault -replace '\\', '/'
  $lines = Get-Content $cfgPath | ForEach-Object {
    if (-not $done -and $_ -match '^vault = ') {
      $done = $true
      'vault = "' + $vaultToml + '"'
    } else { $_ }
  }
  if (-not $done) { throw "could not find a 'vault = ' line in $cfgPath" }
  Write-Utf8 $cfgPath $lines

  if (-not $BigVault) {
    Remove-Item $note, $note2, $trash -ErrorAction SilentlyContinue
  }

  # --- Launch ----------------------------------------------------------------
  # No setsid here: Windows has no POSIX process groups, so the child tree is
  # killed with taskkill /T instead.
  if ($mode -eq 'dev') {
    Write-Host "== launching dev build (log: $log)"
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm.cmd run tauri dev > `"$log`" 2>&1" `
                          -PassThru -WindowStyle Hidden
  } else {
    Write-Host "== launching release binary (log: $log)"
    $proc = Start-Process -FilePath (Join-Path $repo 'target\release\envynote.exe') `
                          -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
  }

  $win = $null
  for ($i = 0; $i -lt 90; $i++) {
    $win = Get-EnvyWindow
    if ($win) { break }
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'error\[E|panicked' -Quiet)) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $win) { throw "window never appeared - see $log" }
  $g = Get-EnvyGeometry $win.MainWindowHandle
  pass "window up at $($g.X),$($g.Y) $($g.W)x$($g.H)"

  Focus-Envy
  Save-Shot '1-launch' | Out-Null

  if ($BigVault) {
    Write-Host "== paging pass: 400 arrow-downs through $vault"
    Send-Key '{ESC}'; Start-Sleep -Milliseconds 300
    Send-Key '%{BS}'; Start-Sleep -Milliseconds 500
    for ($i = 0; $i -lt 400; $i++) { Tap '{DOWN}' }

    # The highlight keeps moving after the last key, so wait for the window to
    # stop changing rather than guessing a sleep.
    $settled = $false
    $a = Save-Shot 'settle-a'
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $b = Save-Shot 'settle-b'
      $ha = (Get-FileHash $a).Hash; $hb = (Get-FileHash $b).Hash
      if ($ha -eq $hb) { $settled = $true; break }
      Move-Item $b $a -Force
    }
    Copy-Item $a (Join-Path $shot '2-paged.png') -Force
    Remove-Item (Join-Path $shot 'settle-a.png'), (Join-Path $shot 'settle-b.png') -ErrorAction SilentlyContinue
    if ($settled) { pass 'window settled after 400 arrow-downs' }
    else { fail 'window still repainting 30s after the last key' }

    # A blank window is the failure this pass is really looking for, and "not
    # blank" is measurable: a real note list has plenty of pixel variance.
    # Computed natively rather than shelling out to ImageMagick.
    $bmp = [System.Drawing.Bitmap]::FromFile((Join-Path $shot '2-paged.png'))
    $sum = 0.0; $sumSq = 0.0; $n = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) {
      for ($x = 0; $x -lt $bmp.Width; $x += 4) {
        $p = $bmp.GetPixel($x, $y)
        $lum = (0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B) / 255.0
        $sum += $lum; $sumSq += $lum * $lum; $n++
      }
    }
    $bmp.Dispose()
    $sd = [Math]::Sqrt(($sumSq / $n) - [Math]::Pow($sum / $n, 2))
    if ($sd -gt 0.02) { pass ("screenshot is not blank (stddev {0:N4})" -f $sd) }
    else { fail ("screenshot looks blank (stddev {0:N4}) - see $shot\2-paged.png" -f $sd) }

    Write-Host '== search still works after paging'
    Send-Key '{ESC}'; Start-Sleep -Milliseconds 500
    foreach ($c in 'note'.ToCharArray()) { Send-Literal $c; Start-Sleep -Milliseconds $keyDelay }
    Start-Sleep -Milliseconds 1500; Save-Shot '3-search' | Out-Null
    Send-Key '%{BS}'; Start-Sleep -Seconds 1; Save-Shot '4-cleared' | Out-Null
    pass 'Escape / type / Alt+Backspace survived (see 3-search.png, 4-cleared.png)'
  }
  else {
    Write-Host '== note written on disk is picked up by the watcher and renders'
    $body = @(
      "# $title", '',
      '| Link | Kind |', '| --- | --- |',
      '| [good](https://example.com) | must be a live link |',
      '| [bad](https:evil.com) | must stay plain text |',
      '| **bold** and `code` | formatting |', '',
      'Prose link: https://envynote.app'
    )
    if ($image) { $body += @('', "![[$image]]") }
    Write-Utf8 $note $body
    Start-Sleep -Seconds 3
    Focus-Envy; Search-For $title; Save-Shot '2-table-and-image' | Out-Null
    pass 'note opened - rendering is checked by eye in 2-table-and-image.png'

    Write-Host '== typing in the editor saves to disk'
    Append-Line "$mark-note"
    if (Select-String -Path $note -Pattern "$mark-note" -Quiet) { pass 'edit saved' }
    else { fail "edit did not reach $note" }

    Write-Host '== arrow keys move the highlight and open the next row (and it stays there)'
    # A second note, written after the first was edited, so with the list sorted
    # newest-first it is row 1 and the original is row 2. Down from the search
    # box must move to row 2, open it, and leave the highlight there.
    Write-Utf8 $note2 @("# $title 2", '', 'Second note for the arrow check.')
    Start-Sleep -Seconds 3
    Focus-Envy; Search-For $title
    Send-Key '{ESC}'; Start-Sleep -Milliseconds 300
    Tap '{DOWN}'; Start-Sleep -Milliseconds 1500
    Save-Shot '2b-arrow-down' | Out-Null
    Append-Line "$mark-arrow"
    $inFirst  = Select-String -Path $note  -Pattern "$mark-arrow" -Quiet
    $inSecond = Select-String -Path $note2 -Pattern "$mark-arrow" -Quiet
    if ($inFirst -and -not $inSecond) { pass 'Down opened the second row and the edit landed there' }
    else { fail "Down did not open the second row (first=$inFirst second=$inSecond)" }
    Remove-Item $note2 -ErrorAction SilentlyContinue

    if ($template) {
      Write-Host '== template opens and saves through the validated template path'
      Copy-Item $template $templateBak
      $tname = [IO.Path]::GetFileNameWithoutExtension($template)
      Focus-Envy; Search-For "template:$tname"; Append-Line "$mark-template"
      Save-Shot '3-template' | Out-Null
      if (Select-String -Path $template -Pattern "$mark-template" -Quiet) { pass 'template saved' }
      else { fail "template edit did not reach $template" }
      Copy-Item $templateBak $template -Force
    } else {
      Write-Host "  skip no templates in $vault\Templates"
    }

    Write-Host "== delete moves the note into the vault's .trash"
    Focus-Envy; Search-For $title
    Send-Key '^{BS}'; Start-Sleep -Milliseconds 2500
    Save-Shot '4-after-delete' | Out-Null
    if (-not (Test-Path $note) -and (Test-Path $trash)) { pass 'moved to .trash' }
    else { fail 'note not in .trash' }
  }

  Write-Host '== app log'
  $errs = @()
  if (Test-Path $log) {
    $errs = Select-String -Path $log -Pattern 'panic|Refused to|Content Security Policy|error' |
            Where-Object { $_.Line -notmatch 'appindicator' }
  }
  if ($errs) {
    fail 'log has errors:'
    $errs | Select-Object -First 5 | ForEach-Object { Write-Host "       $($_.Line)" }
  } else { pass 'no errors' }
}
finally {
  # Restoration must survive a throw or Ctrl+C: the owner's real config is
  # sitting in .smokebak and nothing else has a copy of it.
  if ($proc) { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
  Get-Process envynote -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $cfgBak) { Move-Item $cfgBak $cfgPath -Force }
  if (-not $BigVault) {
    if ($template -and (Test-Path $templateBak)) { Copy-Item $templateBak $template -Force }
    Remove-Item $note, $note2, $trash -ErrorAction SilentlyContinue
  }
}

Write-Host ''
if ($script:fails -eq 0) {
  if ($BigVault) { Write-Host "PASS ($sub) - screenshots in $shot" -ForegroundColor Green }
  else {
    Write-Host "PASS ($sub) - look at $shot\2-table-and-image.png: 'good' underlined, 'bad' plain, image visible." -ForegroundColor Green
  }
  exit 0
} else {
  Write-Host "FAIL ($script:fails) - screenshots and dev.log in $shot" -ForegroundColor Red
  exit 1
}
