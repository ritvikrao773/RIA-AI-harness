# Builds ria.exe using Node.js Single Executable Application (SEA).
# Requires: Node 20+ (uses the installed node), esbuild bundle from build.mjs, npx postject.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "dist\cli.cjs")) { throw "dist\cli.cjs missing - run: npm run build first" }

# 1. SEA config
@'
{
  "main": "dist/cli.cjs",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
'@ | Set-Content -Encoding ASCII dist\sea-config.json

# 2. Generate the blob
node --experimental-sea-config dist\sea-config.json

# 3. Copy node.exe as ria.exe
$nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $nodeExe) { $nodeExe = "$env:ProgramFiles\nodejs\node.exe" }
Copy-Item $nodeExe dist\ria.exe -Force

# 4. Inject the blob (signature removal not needed for unsigned node.exe on Windows)
npx -y postject dist\ria.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 5. Replace the Node icon with Ria's own (copying node.exe inherits its icon).
#    scripts/set-exe-icon.py rewrites the RT_ICON / RT_GROUP_ICON resources
#    in place; it needs pefile (installed to a temp dir, never system-wide).
if (Test-Path "assets\ria.ico") {
  $pefileDir = Join-Path $env:TEMP "ria-pip"
  $prevPP = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = $pefileDir
    python -c "import pefile" 2>$null
    if ($LASTEXITCODE -ne 0) {
      python -m pip install --quiet --target $pefileDir pefile | Out-Null
    }
    python scripts\set-exe-icon.py dist\ria.exe assets\ria.ico dist\ria-icon.tmp.exe
    if ($LASTEXITCODE -eq 0) {
      Move-Item -Force dist\ria-icon.tmp.exe dist\ria.exe
      Write-Host "icon: assets\ria.ico embedded"
    } else {
      Write-Warning "icon step failed; exe keeps the Node icon"
    }
  } finally {
    $env:PYTHONPATH = $prevPP
    Remove-Item dist\ria-icon.tmp.exe -ErrorAction SilentlyContinue
  }
} else {
  Write-Warning "assets\ria.ico missing - exe keeps the Node icon"
}

Write-Host "`nBuilt dist\ria.exe"
