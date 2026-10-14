param([string]$PythonExecutable = '')
$ErrorActionPreference = 'Stop'
if ($PythonExecutable) {
    & $PythonExecutable -c "import sys; assert sys.version_info[:2] == (3, 11), 'CPython 3.11 is required'"
    if ($LASTEXITCODE -ne 0) { throw 'CPython 3.11 is required' }
    Write-Output "Set RADAR_CSK_PYTHON to $PythonExecutable before starting the app."
    exit
}
$runtime = Join-Path $PSScriptRoot '.runtime\python311'
if (Test-Path -LiteralPath (Join-Path $runtime 'python.exe')) { Write-Output 'The isolated CPython 3.11 runtime is already present.'; exit }
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '.runtime') -Force | Out-Null
$archive = Join-Path $PSScriptRoot '.runtime\python311.zip'
# 3.11.9 is the final python.org Windows binary release for the 3.11 series.
# Prefer a maintained local 3.11 build with -PythonExecutable when available.
Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $runtime
& (Join-Path $runtime 'python.exe') -c "import sys; print(sys.version)"
Write-Output 'CSK runtime installed in .runtime only. Install the licensed Infineon Visualization Tool 1.1 separately.'
