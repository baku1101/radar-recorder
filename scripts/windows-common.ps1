Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
function Read-JsonFile([string]$Path) { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
function Write-Utf8File([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false)) }
function Get-PortableRuntime([string]$AppRoot) {
    $marker = Join-Path $AppRoot '.runtime\windows\current.json'
    if (-not (Test-Path -LiteralPath $marker)) { throw '専用runtimeがありません。最初に setup.cmd を実行してください。' }
    $current = Read-JsonFile $marker
    if ($current.runtime_id -notmatch '^[a-f0-9]{16}$') { throw 'runtime識別情報が不正です。setup.cmdを再実行してください。' }
    $runtime = Join-Path $AppRoot ('.runtime\windows\runtimes\' + $current.runtime_id)
    return @{ Root=$runtime; Node=(Join-Path $runtime 'node\node.exe'); Python=(Join-Path $runtime 'python\python.exe'); Marker=$current }
}
