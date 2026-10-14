param([int]$Port = 8765, [string]$DataDirectory = '')
$ErrorActionPreference = 'Stop'
$nodeCandidates = @()
foreach ($nodeRoot in @((Join-Path $env:LOCALAPPDATA 'Volta\tools\image\node'), (Join-Path $env:USERPROFILE 'AppData\Local\Volta\tools\image\node'))) {
    if (Test-Path -LiteralPath $nodeRoot) {
        $nodeCandidates += Get-ChildItem -LiteralPath $nodeRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'node.exe' }
    }
}
$nodeFromPath = Get-Command node -ErrorAction SilentlyContinue
if ($nodeFromPath) { $nodeCandidates += $nodeFromPath.Source }
$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) { throw 'Node.js 22+ is required. See README.md.' }
$previousPort = $env:RADAR_PORT
$previousData = $env:RADAR_DATA_DIR
try {
    $env:RADAR_PORT = [string]$Port
    if ($DataDirectory) { $env:RADAR_DATA_DIR = [System.IO.Path]::GetFullPath($DataDirectory) }
    & $nodeExe (Join-Path $PSScriptRoot 'src\server.mjs')
} finally {
    $env:RADAR_PORT = $previousPort
    $env:RADAR_DATA_DIR = $previousData
}
