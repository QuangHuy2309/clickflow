# Builds the Chrome Web Store upload zip: only manifest.json, src/ and icons/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force dist | Out-Null
$zip = "dist/clickflow-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

# bsdtar (built into Windows 10+) writes forward-slash zip paths, which the store requires.
tar -a -c -f $zip manifest.json src icons
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

Write-Host "Created $zip"
tar -t -f $zip
