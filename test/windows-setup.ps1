param([string]$CacheDirectory = '')
$ErrorActionPreference='Stop'
$source = Split-Path -Parent $PSScriptRoot
$git = (Get-Command git).Source
$files = & $git -C $source ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate public source files.' }
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $source 'test-output\windows-setup-cache' }
$destination = Join-Path ([IO.Path]::GetTempPath()) ('radar setup 日本語 '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $destination | Out-Null
foreach($file in $files) {
    if($file -match '^(\.runtime|data|evidence|test-output|packages|node_modules)/') { throw ('Refusing private input: '+$file) }
    $to = Join-Path $destination $file
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination $to
}
$oldPath=$env:PATH; $oldRawPython=$env:RADAR_RAW_PYTHON; $oldPython=$env:RADAR_CSK_PYTHON; $oldLib=$env:RADAR_CSK_VENDOR_LIB; $oldRawLib=$env:RADAR_RAW_SERIAL_LIB; $oldSettings=$env:RADAR_CSK_RAW_SETTINGS
try {
    $env:PATH=$env:SystemRoot+'\System32;'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0'
    $env:RADAR_RAW_PYTHON=$null; $env:RADAR_CSK_PYTHON=$null; $env:RADAR_CSK_VENDOR_LIB=$null; $env:RADAR_RAW_SERIAL_LIB=$null; $env:RADAR_CSK_RAW_SETTINGS=$null
    if(Test-Path -LiteralPath (Join-Path $destination '.runtime')) { throw 'Clean fixture unexpectedly contains a runtime.' }
    $setupArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $destination 'setup.ps1'))
    if(Test-Path -LiteralPath $CacheDirectory) { $setupArgs+=@('-Offline','-CacheDirectory',$CacheDirectory) }
    & powershell.exe @setupArgs
    if($LASTEXITCODE -ne 0) { throw 'First clean setup failed.' }
    & powershell.exe @setupArgs
    if($LASTEXITCODE -ne 0) { throw 'Idempotent setup failed.' }
    $pointer=Join-Path $destination '.runtime\windows\current.json'
    $before=(Get-FileHash -LiteralPath $pointer -Algorithm SHA256).Hash
    $badCache=Join-Path $destination 'corrupt-test-cache';New-Item -ItemType Directory -Path $badCache | Out-Null
    $packageName=(Get-Content -LiteralPath (Join-Path $destination 'windows-runtime.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json).packages[0].filename
    [IO.File]::WriteAllText((Join-Path $badCache $packageName),'corrupt synthetic fixture')
    $failure=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destination 'setup.ps1') -Offline -CacheDirectory $badCache 2>&1
    if($LASTEXITCODE -eq 0 -or ($failure -join "`n") -notmatch 'SHA256') { throw 'Corrupt dependency was not rejected.' }
    if((Get-FileHash -LiteralPath $pointer -Algorithm SHA256).Hash -ne $before) { throw 'Failed setup changed the installed runtime pointer.' }
    Write-Host 'PASS corrupt dependency rejected before execution; installed runtime unchanged'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destination 'doctor.ps1') -SkipServerCheck
    if($LASTEXITCODE -ne 0) { throw 'Clean doctor failed.' }
    . (Join-Path $destination 'scripts\windows-common.ps1')
    $runtime=Get-PortableRuntime $destination
    & $runtime.Python -I (Join-Path $destination 'src\csk-raw-reader.py') --help
    if($LASTEXITCODE -ne 0) { throw 'Raw reader could not load on portable Python.' }
    & $runtime.Node (Join-Path $destination 'test\windows-setup-smoke.mjs')
    if($LASTEXITCODE -ne 0) { throw 'Portable mock smoke failed.' }
    Write-Host ('PASS clean Windows PowerShell '+$PSVersionTable.PSVersion+' / no global Node/Python/vendor / '+$destination)
} finally {
    $env:PATH=$oldPath; $env:RADAR_RAW_PYTHON=$oldRawPython; $env:RADAR_CSK_PYTHON=$oldPython; $env:RADAR_CSK_VENDOR_LIB=$oldLib; $env:RADAR_RAW_SERIAL_LIB=$oldRawLib; $env:RADAR_CSK_RAW_SETTINGS=$oldSettings
    # Retain isolated installation for inspection; never remove a running application.
}
