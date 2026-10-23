param([string]$Proxy='', [switch]$UseSystemProxy, [switch]$ProxyUseDefaultCredentials)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
. (Join-Path $PSScriptRoot 'scripts\setup-network.ps1')
try {
    if(-not $Proxy -and -not $UseSystemProxy) {
        Write-Host 'このアプリのダウンロード専用設定です。Windowsのproxy設定は変更しません。'
        $choice=Read-Host 'Windows登録済みproxy/PACなら1、手動proxy URLなら2'
        if($choice -eq '1'){$UseSystemProxy=$true}elseif($choice -eq '2'){$Proxy=Read-Host 'proxy URL（http://host:port、認証情報なし）'}else{throw '設定を保存しませんでした。'}
        $auth=Read-Host 'proxy宛に現在のWindowsアカウントの統合認証を使う場合は y（パスワード入力・保存なし）'
        $ProxyUseDefaultCredentials=($auth -eq 'y')
    }
    if($Proxy -and $UseSystemProxy){throw 'ProxyとUseSystemProxyは同時指定できません。'}
    $mode='system';$address=''
    if($Proxy){$mode='proxy';$address=(Assert-SetupProxyUri $Proxy).AbsoluteUri}
    $authentication='none';if($ProxyUseDefaultCredentials){$authentication='windows'}
    Write-Utf8File (Join-Path $PSScriptRoot 'setup-network.local.json') (@{schema_version=1;mode=$mode;proxy=$address;authentication=$authentication}|ConvertTo-Json)
    Write-Host 'アプリ内のproxy選択だけを保存しました。秘密情報は保存していません。続けてsetup.cmdを実行してください。'
} catch {Write-Host ('proxy設定エラー: '+$_.Exception.Message) -ForegroundColor Red;exit 1}
