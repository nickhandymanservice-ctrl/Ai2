#Requires -Version 5.1
<#
.SYNOPSIS
    Bootstraps a Windows dev environment for AionUi (ai2).

.DESCRIPTION
    Verifies Node.js (>=22 <25), Bun, Git, and (for native modules) Python
    plus the Visual Studio C++ build tools. Offers to install missing
    prerequisites via winget, then runs `bun install`.

.PARAMETER SkipInstall
    Verify tools but do not run `bun install`.

.PARAMETER SkipBuildTools
    Skip the MSVC build-tools check. Use only if you already have a working
    node-gyp toolchain.

.EXAMPLE
    pwsh -File .\scripts\windows-setup.ps1
#>

[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipBuildTools
)

$ErrorActionPreference = 'Stop'

function Test-Command {
    param([Parameter(Mandatory)][string]$Name)
    return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajor {
    if (-not (Test-Command 'node')) { return $null }
    try { [int]((node --version).TrimStart('v').Split('.')[0]) } catch { $null }
}

function Install-Winget {
    param(
        [Parameter(Mandatory)][string]$Id,
        [string]$Label = $Id,
        [string]$Override
    )
    if (-not (Test-Command 'winget')) {
        Write-Warning "winget is unavailable. Install '$Label' manually."
        return $false
    }
    $wingetArgs = @('install', '--id', $Id, '--silent',
                    '--accept-package-agreements', '--accept-source-agreements')
    if ($Override) { $wingetArgs += @('--override', $Override) }
    Write-Host "Installing $Label via winget..." -ForegroundColor Cyan
    winget @wingetArgs
    return ($LASTEXITCODE -eq 0)
}

Write-Host ''
Write-Host '=== AionUi (ai2) Windows setup ===' -ForegroundColor Green
Write-Host ''

# ---- Node.js ----
$nodeMajor = Get-NodeMajor
if ($null -eq $nodeMajor) {
    Write-Host 'Node.js: not found.' -ForegroundColor Yellow
    Install-Winget -Id 'OpenJS.NodeJS' -Label 'Node.js (current)' | Out-Null
    Write-Host 'Open a new PowerShell window, then re-run this script.' -ForegroundColor Yellow
    return
} elseif ($nodeMajor -lt 22 -or $nodeMajor -ge 25) {
    Write-Warning "Node.js v$nodeMajor detected. AionUi requires >=22 and <25."
    Write-Warning 'Switch with nvm-windows: nvm install 22 && nvm use 22'
} else {
    Write-Host "Node.js v$nodeMajor: OK" -ForegroundColor Green
}

# ---- Bun ----
if (-not (Test-Command 'bun')) {
    Write-Host 'Bun: not found.' -ForegroundColor Yellow
    Write-Host 'Installing Bun via official installer (irm bun.sh/install.ps1)...' -ForegroundColor Cyan
    powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex'
    $bunBin = Join-Path $env:USERPROFILE '.bun\bin'
    if (Test-Path $bunBin) { $env:PATH = "$bunBin;$env:PATH" }
    if (Test-Command 'bun') {
        Write-Host "Bun $(bun --version): installed" -ForegroundColor Green
    } else {
        Write-Warning 'Bun did not register in PATH. Open a new PowerShell window and re-run this script.'
        return
    }
} else {
    Write-Host "Bun $(bun --version): OK" -ForegroundColor Green
}

# ---- Git ----
if (-not (Test-Command 'git')) {
    Write-Host 'Git: not found.' -ForegroundColor Yellow
    Install-Winget -Id 'Git.Git' -Label 'Git' | Out-Null
} else {
    Write-Host "$(git --version): OK" -ForegroundColor Green
}

# ---- Native module toolchain ----
if (-not $SkipBuildTools) {
    if (-not (Test-Command 'python')) {
        Write-Host 'Python: not found (required by node-gyp).' -ForegroundColor Yellow
        Install-Winget -Id 'Python.Python.3.12' -Label 'Python 3.12' | Out-Null
    } else {
        Write-Host "$(python --version): OK" -ForegroundColor Green
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $hasMsvc = $false
    if (Test-Path $vswhere) {
        try {
            $found = & $vswhere -latest -products * `
                -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' `
                -property installationPath 2>$null
            if ($found) { $hasMsvc = $true }
        } catch { }
    }

    if (-not $hasMsvc) {
        Write-Host 'MSVC C++ build tools: not detected.' -ForegroundColor Yellow
        Install-Winget -Id 'Microsoft.VisualStudio.2022.BuildTools' -Label 'VS 2022 Build Tools' `
            -Override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' | Out-Null
    } else {
        Write-Host 'MSVC C++ build tools: OK' -ForegroundColor Green
    }
}

if ($SkipInstall) {
    Write-Host ''
    Write-Host 'Skipping install step (-SkipInstall set).' -ForegroundColor Yellow
    return
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot
try {
    Write-Host ''
    Write-Host 'Running bun install (postinstall rebuilds native modules for Electron)...' -ForegroundColor Cyan
    bun install
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  bun run start         # launch Electron dev app'
Write-Host '  bun run webui         # launch the web UI variant'
Write-Host '  bun run test          # vitest'
Write-Host '  bun run dist:win      # produce a Windows distributable'
