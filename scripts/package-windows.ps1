param([Parameter(Mandatory=$true)][string]$OutputDirectory, [string]$CacheDirectory = '', [string]$Git = 'git')
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$appRoot = Split-Path -Parent $PSScriptRoot
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$version = (Read-JsonFile (Join-Path $appRoot 'package.json')).version
$lock = Read-JsonFile (Join-Path $appRoot 'windows-runtime.lock.json')
$files = & $Git -C $appRoot ls-files
if ($LASTEXITCODE -ne 0) { throw 'Git tracked file list is required.' }
foreach ($mode in @('online','offline')) {
    if ($mode -eq 'offline' -and -not $CacheDirectory) { continue }
    $stage = Join-Path $OutputDirectory ('stage-'+[guid]::NewGuid().ToString('N'))
    $bundle = Join-Path $stage ('radar-recorder-'+$version)
    New-Item -ItemType Directory -Path $bundle | Out-Null
    $inventory = @()
    foreach ($file in $files) {
        if ($file -match '^(data|evidence|test-output|\.runtime|packages|node_modules)/' -or $file -match '\.(hex|bin|elf|exe|dll|pyc|png|zip|gz)$' -or $file -match 'existing-diagnostic') { throw ('Private/binary file in tracked list: '+$file) }
        $from = Join-Path $appRoot $file
        $to = Join-Path $bundle $file
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to
        $inventory += @{ path=$file; sha256=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    if ($mode -eq 'offline') {
        $packages = Join-Path $bundle 'packages'; New-Item -ItemType Directory -Path $packages | Out-Null
        foreach ($package in $lock.packages) {
            $from=Join-Path $CacheDirectory $package.filename
            if ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.sha256) { throw ('Dependency checksum mismatch: '+$package.filename) }
            Copy-Item -LiteralPath $from -Destination (Join-Path $packages $package.filename)
        }
    }
    $commit = & $Git -C $appRoot rev-parse HEAD
    Write-Utf8File (Join-Path $bundle 'DISTRIBUTION.json') (@{ version=$version; mode=$mode; source_commit=$commit; files=$inventory; dependency_lock=$lock; contains_private_data=$false; firmware_included=$false } | ConvertTo-Json -Depth 12)
    $zip = Join-Path $OutputDirectory ('radar-recorder-'+$version+'-windows-x64-'+$mode+'.zip')
    if (Test-Path -LiteralPath $zip) { throw ('Refusing to overwrite existing archive: '+$zip) }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
    $digest=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8File ($zip+'.sha256') ($digest+'  '+[IO.Path]::GetFileName($zip)+"`n")
    Write-Host ($zip+' / '+(Get-Item -LiteralPath $zip).Length+' bytes / '+$digest)
    # Staging is retained under OutputDirectory for review. It is never copied from private roots.
}
