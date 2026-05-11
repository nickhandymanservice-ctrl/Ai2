# Windows (PowerShell) setup

AionUi is an Electron app with native modules (`better-sqlite3`, `sharp`, etc.),
so a Windows build requires both a JavaScript runtime and a working C++ toolchain.

## Prerequisites

| Tool                | Version    | Notes                                          |
| ------------------- | ---------- | ---------------------------------------------- |
| Node.js             | `>=22 <25` | See `engines.node` in `package.json`           |
| Bun                 | latest     | Primary package manager                        |
| Git                 | latest     |                                                |
| Python              | 3.12.x     | Required by `node-gyp` for native deps         |
| VS 2022 Build Tools | 2022       | "Desktop development with C++" workload        |
| Windows SDK         | 10/11      | Installed alongside the C++ workload           |

## Automated setup

```powershell
pwsh -File .\scripts\windows-setup.ps1
```

What it does:

1. Verifies / installs Node.js, Bun, Git, Python, and the MSVC build tools.
2. Runs `bun install`, which triggers the postinstall hook that rebuilds
   native modules against the bundled Electron version.

### Flags

- `-SkipInstall` — verify tools but skip `bun install`.
- `-SkipBuildTools` — skip the MSVC toolchain check. Only use this if you
  already have a working `node-gyp` setup.

## Manual setup

```powershell
# 1. Install prerequisites
winget install OpenJS.NodeJS
winget install Git.Git
winget install Python.Python.3.12
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Bun (official installer)
irm bun.sh/install.ps1 | iex

# 2. Clone the repo
git clone https://github.com/nickhandymanservice-ctrl/ai2.git
Set-Location ai2

# 3. Install deps (postinstall runs electron-rebuild)
bun install
```

## Common tasks

```powershell
bun run start              # Electron dev mode
bun run webui              # web UI variant
bun run webui:prod         # production web UI
bun run test               # vitest
bun run lint               # eslint
bun run dist:win           # build a Windows installer (.exe / .msi)
```

## Troubleshooting

### `better-sqlite3` or `sharp` fail to build

Confirm Python and MSVC are visible:

```powershell
python --version
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

Then re-run the postinstall step:

```powershell
bun pm trust --all
node scripts/postinstall.js
```

### `bun` not recognized after install

Open a new PowerShell window. The installer adds `%USERPROFILE%\.bun\bin`
to PATH, but only future sessions inherit it. Quick fix for the current
session:

```powershell
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
```

### Execution policy blocks the setup script

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Electron download is blocked / very slow

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
bun install
```

### Long path errors

```powershell
git config --system core.longpaths true
```
