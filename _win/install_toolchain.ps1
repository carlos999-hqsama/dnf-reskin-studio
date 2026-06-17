# DNF reskin toolchain installer (SLIM)  -- run in an ELEVATED PowerShell
# Installs ONLY what compiling needs: MSVC compiler + Windows SDK + CMake. ~2.5-3GB.
$ErrorActionPreference = 'Continue'
$log = 'D:\dnf-reskin\install_toolchain.log'
"START $(Get-Date -Format o)" | Set-Content -LiteralPath $log

Write-Host "[1/2] Installing MSVC compiler + Windows 11 SDK (no extra recommended bloat). ~2.5-3GB..."
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --accept-package-agreements --accept-source-agreements `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621" 2>&1 |
  Tee-Object -FilePath $log -Append
"VSBT_EXIT=$LASTEXITCODE" | Add-Content -LiteralPath $log

Write-Host "[2/2] Installing CMake (standalone, ~100MB)..."
winget install --id Kitware.CMake -e `
  --accept-package-agreements --accept-source-agreements 2>&1 |
  Tee-Object -FilePath $log -Append
"CMAKE_EXIT=$LASTEXITCODE" | Add-Content -LiteralPath $log

# Verify MSVC landed
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path -LiteralPath $vswhere) {
  $p = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>&1
  "MSVC_PATH=$p" | Add-Content -LiteralPath $log
} else { "MSVC_PATH=NONE(vswhere missing)" | Add-Content -LiteralPath $log }

"DONE $(Get-Date -Format o)" | Add-Content -LiteralPath $log
Write-Host "`n=== DONE. Tell 27 it's finished. Log: $log ==="
