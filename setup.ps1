param([string]$CacheDirectory = '', [switch]$Offline)
# PowerShell 5.1; application-local, versioned runtimes. No installer, registry or PATH edits.
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
try {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'この配布物はWindows 10/11 x64専用です。ARM64/32bit版には対応していません。' }
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10または11が必要です。' }
    $distribution=Join-Path $PSScriptRoot 'DISTRIBUTION.json'
    if (Test-Path -LiteralPath $distribution) { if ((Read-JsonFile $distribution).mode -eq 'offline') { $Offline=$true } }
    if (-not $CacheDirectory) { $CacheDirectory = Join-Path $PSScriptRoot 'packages' }
    $CacheDirectory = [IO.Path]::GetFullPath($CacheDirectory)
    New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
    $lockFile = Join-Path $PSScriptRoot 'windows-runtime.lock.json'
    $lock = Read-JsonFile $lockFile
    $lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $runtimeId = $lockHash.Substring(0,16)
    $base = Join-Path $PSScriptRoot '.runtime\windows'
    $target = Join-Path $base ('runtimes\' + $runtimeId)
    New-Item -ItemType Directory -Force -Path (Join-Path $base 'runtimes') | Out-Null
    # FileShare.None prevents two setup operations from publishing a half-built runtime.
    $setupLock = [IO.File]::Open((Join-Path $base 'setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        $serialLicense=Join-Path $PSScriptRoot 'licenses\pyserial-3.5-LICENSE.txt'
        if ((Get-FileHash -LiteralPath $serialLicense -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.licenses[0].sha256) { throw 'pyserialライセンスのhashが一致しません。配布物を取得し直してください。' }
        foreach ($package in $lock.packages) {
            if ($package.filename -notmatch '^[A-Za-z0-9._-]+$' -or $package.sha256 -notmatch '^[a-f0-9]{64}$') { throw '依存lockが不正です。' }
            $archive = Join-Path $CacheDirectory $package.filename
            if (-not (Test-Path -LiteralPath $archive)) {
                if ($Offline) { throw ('offline packageがありません: ' + $package.filename) }
                Write-Host ('公式配布から取得しています: ' + $package.id + ' ' + $package.version)
                $partial = $archive + '.' + [guid]::NewGuid().ToString('N') + '.part'
                Invoke-WebRequest -UseBasicParsing -Uri $package.url -OutFile $partial -TimeoutSec 180
                if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.sha256) { throw ('SHA256不一致です。実行していません: ' + $package.filename) }
                Move-Item -LiteralPath $partial -Destination $archive
            }
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.sha256) { throw ('packageのSHA256不一致です。packages内の該当ファイルを除いて再取得してください: ' + $package.filename) }
            Write-Host ('SHA256 OK: ' + $package.filename)
        }
        if (-not (Test-Path -LiteralPath (Join-Path $target 'installed.json'))) {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $stage = Join-Path $base ('staging-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stage | Out-Null
            $nodePackage = $lock.packages | Where-Object { $_.id -eq 'node' }
            $pythonPackage = $lock.packages | Where-Object { $_.id -eq 'python' }
            $serialPackage = $lock.packages | Where-Object { $_.id -eq 'pyserial' }
            # The application has no npm dependencies. Avoid unpacking npm's deep tree,
            # which exceeds PowerShell 5.1 / .NET Framework MAX_PATH in ordinary folders.
            $nodeDirectory=Join-Path $stage 'node'; New-Item -ItemType Directory -Path $nodeDirectory | Out-Null
            $nodeArchive=[IO.Compression.ZipFile]::OpenRead((Join-Path $CacheDirectory $nodePackage.filename))
            try {
                foreach($name in @('node.exe','LICENSE','README.md','CHANGELOG.md')) {
                    $entry=$nodeArchive.GetEntry('node-v'+$nodePackage.version+'-win-x64/'+$name)
                    if(-not $entry) { throw ('公式Node ZIPの構造が不正です: '+$name) }
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $nodeDirectory $name),$false)
                }
            } finally { $nodeArchive.Dispose() }
            [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $CacheDirectory $pythonPackage.filename), (Join-Path $stage 'python'))
            [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $CacheDirectory $serialPackage.filename), (Join-Path $stage 'python\site-packages'))
            Copy-Item -LiteralPath $serialLicense -Destination (Join-Path $stage 'python\site-packages\pyserial-3.5.dist-info\LICENSE.txt')
            $pythonPth = Get-ChildItem -LiteralPath (Join-Path $stage 'python') -Filter 'python*._pth' | Select-Object -First 1
            # Keep isolated mode; no user site, PYTHONPATH or global installation is used.
            $pythonZip = (Get-ChildItem -LiteralPath (Join-Path $stage 'python') -Filter 'python*.zip' | Select-Object -First 1).Name
            Write-Utf8File $pythonPth.FullName ($pythonZip + "`n.`nsite-packages`n")
            $python = Join-Path $stage 'python\python.exe'
            $node = Join-Path $stage 'node\node.exe'
            & $node --version
            if ($LASTEXITCODE -ne 0) { throw '専用Nodeが起動できません。' }
            & $python -I -c "import serial,sys; assert serial.VERSION == '3.5'; print('Python '+sys.version.split()[0]+' / pyserial '+serial.VERSION)"
            if ($LASTEXITCODE -ne 0) { throw '専用Python/pyserialが起動できません。' }
            Write-Utf8File (Join-Path $stage 'installed.json') (@{ schema_version=1; lock_sha256=$lockHash; platform='win32-x64' } | ConvertTo-Json)
            # Only moves this new staging directory, inside the verified application-local base.
            $basePrefix=[IO.Path]::GetFullPath($base).TrimEnd('\')+'\'
            foreach($movingPath in @($stage,$target)) { if(-not [IO.Path]::GetFullPath($movingPath).StartsWith($basePrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'runtime配置先がアプリ内ではありません。' } }
            if (Test-Path -LiteralPath $target) { throw '未完了runtimeが同じ場所にあります。既存ファイルを削除せず停止しました。' }
            Move-Item -LiteralPath $stage -Destination $target
        }
        $next = Join-Path $base ('current-' + [guid]::NewGuid().ToString('N') + '.json')
        Write-Utf8File $next (@{ schema_version=1; runtime_id=$runtimeId; lock_sha256=$lockHash } | ConvertTo-Json)
        $pointer = Join-Path $base 'current.json'
        if (Test-Path -LiteralPath $pointer) { [IO.File]::Replace($next, $pointer, ($next+'.previous'), $true) } else { [IO.File]::Move($next, $pointer) }
    } finally { $setupLock.Dispose() }
    Write-Host 'セットアップ完了。doctor.cmdで確認し、start.cmdで起動してください。管理者権限・メーカーアプリは不要です。'
    Write-Host 'センサーFWの書込み・COM接続・収録は行っていません。'
} catch {
    Write-Host ('セットアップを完了できませんでした: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '展開済みの書込可能なフォルダで実行してください。オンライン版は公式サイトへのHTTPS接続が必要です。'
    exit 1
}
