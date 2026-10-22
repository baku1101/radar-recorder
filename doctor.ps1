param([ValidateRange(1,65535)][int]$Port = 8765, [switch]$SkipServerCheck, [switch]$ListPorts)
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
try {
    $runtime = Get-PortableRuntime $PSScriptRoot
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'windows-runtime.lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($runtime.Marker.lock_sha256 -ne $lockHash) { throw '依存の版が変わっています。setup.cmdを再実行してください。' }
    & $runtime.Node (Join-Path $PSScriptRoot 'scripts\doctor.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Node/設定の確認に失敗しました。' }
    & $runtime.Python -I -c "import serial,sys,ssl; assert serial.VERSION=='3.5'; print('OK Python '+sys.version.split()[0]+' / pyserial '+serial.VERSION+' / SSL')"
    if ($LASTEXITCODE -ne 0) { throw 'Python/pyserialの確認に失敗しました。setup.cmdを確認してください。' }
    if ($ListPorts) {
        Write-Host 'COM一覧を列挙します。ポートを開かず、機器への送信は行いません。'
        & $runtime.Python -I -m serial.tools.list_ports -v
        if ($LASTEXITCODE -ne 0) { throw 'COM列挙に失敗しました。' }
    } else { Write-Host 'COM・FW・センサー取得は未試験です。COM番号はデバイスマネージャーで確認してください。' }
    if (-not $SkipServerCheck) {
        $probe = [Net.Sockets.TcpClient]::new()
        try { $pending = $probe.ConnectAsync('127.0.0.1',$Port); $occupied = $pending.Wait(500) -and $probe.Connected } catch { $occupied=$false } finally { $probe.Dispose() }
        if ($occupied) {
            try { $server = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 2; Write-Host ('使用中port '+$Port+' / app '+$server.app.id+' / version '+$server.app.version) } catch { Write-Host ('port '+$Port+' は使用中です。停止操作は行っていません。') }
        } else { Write-Host ('OK 起動用port '+$Port+' は空いています。') }
    }
    Write-Host 'PC側の確認に通りました。raw FW radc-0.2.0導入済みキット専用です。新規キットへの自動書込みはありません。'
} catch { Write-Host ('確認エラー: '+$_.Exception.Message) -ForegroundColor Red; exit 1 }
