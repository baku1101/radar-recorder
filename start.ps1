param([ValidateRange(1,65535)][int]$Port = 8765, [string]$DataDirectory = '')
$ErrorActionPreference = 'Stop'
$expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$portInUse = $false
$probe = [System.Net.Sockets.TcpClient]::new()
try { $pendingConnect = $probe.ConnectAsync('127.0.0.1', $Port); $portInUse = $pendingConnect.Wait(750) -and $probe.Connected } catch { } finally { $probe.Dispose() }
if ($portInUse) {
    $runningVersion = 'unknown / older server'
    try { $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2; if ($existing.app.id -eq 'radar-recorder-local') { $runningVersion = $existing.app.version } } catch { }
    throw "Port $Port is already in use. Running server: $runningVersion; files: $expectedVersion. No second server was started. If this is radar-recorder, finish recording, stop its original window with Ctrl+C, then run start.cmd again. If the current server is already correct, reload http://127.0.0.1:$Port in your browser."
}
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
