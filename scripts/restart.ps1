#Requires -Version 5.1
<#
.SYNOPSIS
    Cursor Voice — restart script for Windows

.DESCRIPTION
    1. Builds the project (backend + PWA)
    2. Restarts the CursorVoice Windows service
    3. Runs a health check against /healthz
    4. Optionally streams the log

.PARAMETER NoBuild
    Skip the build step (restart only — handy for config-only changes)

.PARAMETER Tail
    Stream bridge.log after restart (Ctrl-C to stop)

.EXAMPLE
    .\scripts\restart.ps1

.EXAMPLE
    .\scripts\restart.ps1 -NoBuild -Tail
#>
[CmdletBinding()]
param(
    [switch] $NoBuild,
    [switch] $Tail
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve paths ─────────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# ── Helpers ───────────────────────────────────────────────────────────────
function Info    ($msg) { Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Ok      ($msg) { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Warn    ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Err     ($msg) { Write-Host "[err]   $msg" -ForegroundColor Red; throw $msg }
function Section ($msg) { Write-Host "`n── $msg ──" -ForegroundColor Magenta }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

Write-Host "Cursor Voice — restart (Windows)" -ForegroundColor Magenta
Write-Host "  Project: $ProjectDir"

$ServiceName = 'CursorVoice'
$EnvFile     = Join-Path $ProjectDir '.env'
$LogFile     = Join-Path $ProjectDir 'logs\bridge.log'

# ── Load .env for PORT ────────────────────────────────────────────────────
$ActualPort = 8787
if (Test-Path $EnvFile) {
    $portLine = Select-String -Path $EnvFile -Pattern '^PORT=(.+)' |
                Select-Object -First 1
    if ($portLine) {
        $ActualPort = [int]$portLine.Matches[0].Groups[1].Value.Trim()
    }
}

# ── 1. Build ──────────────────────────────────────────────────────────────
if ($NoBuild) {
    Section "Skipping build (-NoBuild)"
    Warn "Using existing dist\index.js"
} else {
    Section "Building"
    Info "Installing / checking dependencies..."
    npm ci --no-audit --prefer-offline
    if ($LASTEXITCODE -ne 0) { npm install --no-audit }

    Info "Building backend + PWA..."
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    npm run build
    if ($LASTEXITCODE -ne 0) { Err "Build failed — check output above." }
    $sw.Stop()
    Ok "Build done in $([int]$sw.Elapsed.TotalSeconds)s → dist\index.js"
}

# ── 2. Restart service ────────────────────────────────────────────────────
Section "Restarting service"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($service) {
    # Need admin to restart a Windows service
    if (-not (Test-Admin)) {
        Warn "Relaunching with admin rights to restart the service..."
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                    $MyInvocation.MyCommand.Path, '-NoBuild')
        if ($Tail) { $psArgs += '-Tail' }
        Start-Process pwsh -ArgumentList $psArgs -Verb RunAs -Wait
        exit
    }

    Info "Stopping '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep 2

    Info "Starting '$ServiceName'..."
    Start-Service -Name $ServiceName
    Start-Sleep 2

    $svc = Get-Service -Name $ServiceName
    if ($svc.Status -eq 'Running') {
        Ok "'$ServiceName' is running."
    } else {
        Warn "'$ServiceName' status: $($svc.Status). Check logs:"
        Warn "  Get-Content '$LogFile' -Tail 30"
    }
} else {
    Warn "Service '$ServiceName' not found."
    Warn "Did you run setup.ps1 first? Trying to start manually..."

    $NodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source
    if (-not $NodeExe) { Err "Node.js not found on PATH." }

    $distFile = Join-Path $ProjectDir 'dist\index.js'
    if (-not (Test-Path $distFile)) { Err "dist\index.js not found — run the build first." }

    New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

    # Load .env as environment variables for this process
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^([^#\s][^=]+)=(.+)$') {
                [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
            }
        }
    }

    $proc = Start-Process -FilePath $NodeExe `
        -ArgumentList $distFile `
        -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError (Join-Path $ProjectDir 'logs\bridge-error.log') `
        -WindowStyle Hidden `
        -PassThru

    Start-Sleep 2
    if (-not $proc.HasExited) {
        Ok "Bridge started (pid $($proc.Id)). Log: $LogFile"
        $proc.Id | Set-Content (Join-Path $ProjectDir 'data\.bridge.pid')
    } else {
        Err "Bridge exited immediately. Check: Get-Content '$LogFile' -Tail 30"
    }
}

# ── 3. Health check ───────────────────────────────────────────────────────
Section "Health check"

Start-Sleep 2
$healthUrl = "http://127.0.0.1:$ActualPort/healthz"
try {
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
    Ok "Bridge is healthy at $healthUrl"
    $resp | ConvertTo-Json -Depth 3
} catch {
    Warn "Health check failed at $healthUrl — bridge may still be starting."
    Warn "Try: Invoke-RestMethod $healthUrl"
}

# ── 4. Optional log tail ──────────────────────────────────────────────────
if ($Tail) {
    Write-Host ""
    Info "Tailing $LogFile (Ctrl-C to stop)..."
    Get-Content $LogFile -Wait
}

Write-Host ""
Ok "Restart complete."
Write-Host "  Logs: Get-Content '$LogFile' -Wait"
Write-Host ""
