# Builds clean per-browser upload zips with forward-slash paths.
#   lyve-chrome.zip   -> uses manifest.json          (service_worker, no Chrome warning)
#   lyve-firefox.zip  -> uses manifest.firefox.json  (scripts, no Firefox warning)
# Run from this folder:  .\build.ps1
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression.FileSystem

$includeFiles = @(
  'background.js', 'content.js', 'firebaseConfig.js',
  'popup.html', 'popup.css', 'popup.js', 'styles.css', 'THIRD_PARTY_NOTICES.md'
)
$includeDirs = @('modules', 'assets')

function Add-ZipEntry($zip, $name, $path) {
  $entry = $zip.CreateEntry($name)
  $stream = $entry.Open()
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Close()
}

function New-LyveZip($dest, $manifestFile) {
  $fs = [System.IO.File]::Open($dest, [System.IO.FileMode]::Create)
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  Add-ZipEntry $zip 'manifest.json' (Join-Path $src $manifestFile)
  foreach ($f in $includeFiles) { Add-ZipEntry $zip $f (Join-Path $src $f) }
  foreach ($d in $includeDirs) {
    Get-ChildItem (Join-Path $src $d) -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($src.Length + 1) -replace '\\', '/'
      Add-ZipEntry $zip $rel $_.FullName
    }
  }
  $zip.Dispose()
  $fs.Close()
}

New-LyveZip (Join-Path $src 'lyve-chrome.zip') 'manifest.json'
New-LyveZip (Join-Path $src 'lyve-firefox.zip') 'manifest.firefox.json'
Write-Host "Built lyve-chrome.zip and lyve-firefox.zip"
