$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = (Resolve-Path "$ScriptDir\..").Path
$RootDir = (Resolve-Path "$DesktopDir\..\..").Path
$env:PATH = "$RootDir\node_modules\.bin;$env:PATH"

# Build the Electron main process
npm run build:main

$env:NEOLIX_DEV_ROOT = $RootDir
$env:NEOLIX_DEV_RUNTIME_FALLBACK_ROOT = $RootDir
$DevRuntime = node "$ScriptDir\dev-runtime.mjs" | ConvertFrom-Json
$env:NEOLIX_ELECTRON_FLAGS = $DevRuntime.electronFlags
$env:NEOLIX_ELECTRON_USER_DATA_DIR = $DevRuntime.userDataDir
Remove-Item Env:\NEOLIX_DEV_RUNTIME_FALLBACK_ROOT -ErrorAction SilentlyContinue

# Allow any origin in dev so Electron on random ports works.
# SECURITY: wildcard CORS is unsafe in production — only acceptable here because
# the daemon binds to localhost and this script is never used for production.
$env:NEOLIX_CORS_ORIGINS = "*"

# Fully isolate the dev instance from a production Neolix install so `npm run dev`
# works while the installed app is open. Without this the dev build loses the
# Electron single-instance lock to the installed app and quits, and ends up
# pointed at the production daemon, whose CORS allowlist rejects the dev origin.
# NEOLIX_HOME defaults to a script-managed dev home. If you override it (to point
# dev at real data), we DON'T touch your config.json — only the managed home gets
# its daemon config seeded below, so we never rewrite a production config.
$DevStateDir = "$DesktopDir\.dev"
if (-not $env:NEOLIX_HOME) {
    $env:NEOLIX_HOME = "$DevStateDir\neox-home"
    $NeolixHomeManaged = $true
} else {
    $NeolixHomeManaged = $false
}
New-Item -ItemType Directory -Force -Path $env:NEOLIX_HOME, $env:NEOLIX_ELECTRON_USER_DATA_DIR | Out-Null

$DevDaemonPort = if ($env:NEOLIX_DEV_DAEMON_PORT) { $env:NEOLIX_DEV_DAEMON_PORT } else { "6788" }
if (-not $env:NEOLIX_LISTEN) { $env:NEOLIX_LISTEN = "127.0.0.1:$DevDaemonPort" }

# Seed the isolated daemon config. The desktop daemon-manager decides whether a
# daemon is already running by reading `daemon.listen` from this config.json
# (it does NOT honor the NEOLIX_LISTEN env var) and probing that address. Without
# this it reads the default 6767, finds a production daemon there, and connects
# the dev app to prod — whose CORS allowlist then rejects the dev origin. Pin
# the dev port + wildcard CORS in the file so the dev app starts its OWN daemon.
# ONLY seed the script-managed home: never rewrite a user-supplied NEOLIX_HOME
# (that could clobber a production config.json with the dev port + wildcard CORS).
if ($NeolixHomeManaged) {
    $env:TMP_CFG_PATH = "$($env:NEOLIX_HOME)/config.json"
    $env:TMP_CFG_PORT = $DevDaemonPort
    $TmpScript = [System.IO.Path]::GetTempFileName() + ".js"
    $ScriptContent = @"
const fs = require('fs');
const path = process.env.TMP_CFG_PATH;
const port = process.env.TMP_CFG_PORT;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = '127.0.0.1:' + port;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ['*'];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
"@
    Set-Content -Path $TmpScript -Value $ScriptContent
    node $TmpScript
    Remove-Item $TmpScript -ErrorAction SilentlyContinue
    Remove-Item Env:\TMP_CFG_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\TMP_CFG_PORT -ErrorAction SilentlyContinue
} else {
    Write-Host "  (custom NEOLIX_HOME - leaving its config.json untouched)"
}

$WebUiLabel = if ($env:NEOLIX_DESKTOP_WEB_URL) { $env:NEOLIX_DESKTOP_WEB_URL } else { "daemon $($env:NEOLIX_LISTEN)" }

Write-Host @"
======================================================
  Neolix Desktop Dev (Windows)
======================================================
  Web UI:     $WebUiLabel
  Daemon:     $($env:NEOLIX_LISTEN) (isolated)
  NEOLIX_HOME: $($env:NEOLIX_HOME)
  userData:   $($env:NEOLIX_ELECTRON_USER_DATA_DIR)
======================================================
"@

npx electron "$DesktopDir"
exit $LASTEXITCODE