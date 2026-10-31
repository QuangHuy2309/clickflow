# Builds the Chrome Web Store upload zip: only manifest.json, _locales/, src/ and icons/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force dist | Out-Null
$zip = "dist/clickflow-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

# bsdtar (built into Windows 10+) writes forward-slash zip paths, which the store requires.
# Call it by full path: Git's GNU tar can come first on PATH, and it ignores
# the .zip extension and writes a tar archive the store rejects.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -a -c -f $zip manifest.json _locales src icons
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
$magic = [System.IO.File]::ReadAllBytes((Resolve-Path $zip))[0..1]
if ($magic[0] -ne 0x50 -or $magic[1] -ne 0x4B) { throw "$zip is not a zip file" }

Write-Host "Created $zip"
& $tar -t -f $zip
