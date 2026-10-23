# Windows PowerShell 5.1 / .NET Framework. Download policy only; no OS settings edits.
Add-Type -AssemblyName System.Net.Http
function Assert-SetupProxyUri([string]$Value) {
    $uri=$null
    if (-not [Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or -not $uri.Host) {
        throw 'SETUP_PROXY_INPUT: proxyは http://host:port 形式で指定してください。ユーザー名・パスワード・token・path・queryは含められません。'
    }
    return $uri
}
function Get-SetupNetworkPolicy {
    param([string]$AppRoot,[string]$Proxy='', [switch]$UseSystemProxy,[switch]$ProxyUseDefaultCredentials)
    if($Proxy -and $UseSystemProxy) { throw 'SETUP_PROXY_INPUT: -Proxy と -UseSystemProxy は同時に指定できません。' }
    $mode='system';$source='Windows Internet Options / PAC';$auth='none';$address='';$bypass=''
    $configFile=Join-Path $AppRoot 'setup-network.local.json'
    $config=$null
    if(Test-Path -LiteralPath $configFile) {
        try { $config=Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'SETUP_PROXY_INPUT: setup-network.local.json を読めません。設定をやり直してください。' }
        if(@($config.PSObject.Properties.Name | Where-Object { $_ -notin @('schema_version','mode','proxy','authentication') }).Count -or $config.mode -notin @('system','proxy') -or $config.authentication -notin @('none','windows')) { throw 'SETUP_PROXY_INPUT: ローカルproxy設定の項目が不正です。秘密情報は保存しないでください。' }
        $mode=$config.mode;$auth=$config.authentication;$source='app-local settings'
        if($mode -eq 'proxy') { $address=[string]$config.proxy }
    } else {
        if($env:HTTPS_PROXY) { $mode='proxy';$address=$env:HTTPS_PROXY;$source='HTTPS_PROXY' }
        elseif($env:HTTP_PROXY) { $mode='proxy';$address=$env:HTTP_PROXY;$source='HTTP_PROXY' }
        $bypass=[string]$env:NO_PROXY
    }
    if($Proxy) { $mode='proxy';$address=$Proxy;$source='command line';$bypass='' }
    if($UseSystemProxy) { $mode='system';$address='';$source='Windows Internet Options / PAC (explicit)';$bypass='' }
    if($ProxyUseDefaultCredentials) { $auth='windows' }
    $proxyUri=$null
    if($mode -eq 'proxy') { $proxyUri=Assert-SetupProxyUri $address }
    return @{ Mode=$mode;Source=$source;ProxyUri=$proxyUri;Authentication=$auth;NoProxy=$bypass }
}
function Initialize-SetupProxyCredentials {
    if(-not ('RadarSetup.ProxyWindowsCredentials' -as [type])) {
        Add-Type -TypeDefinition @'
using System;using System.Net;
namespace RadarSetup {
 public sealed class ProxyWindowsCredentials : ICredentials {
  public NetworkCredential GetCredential(Uri uri,string authType) {
   if(String.Equals(authType,"Negotiate",StringComparison.OrdinalIgnoreCase)||String.Equals(authType,"NTLM",StringComparison.OrdinalIgnoreCase)||String.Equals(authType,"Kerberos",StringComparison.OrdinalIgnoreCase)) return CredentialCache.DefaultNetworkCredentials;
   return null;
  }
 }
}
'@
    }
}
function Test-SetupNoProxy([Uri]$Uri,[string]$NoProxy) {
    foreach($raw in $NoProxy.Split(',')) {
        $entry=$raw.Trim().ToLowerInvariant();if(-not $entry){continue};if($entry -eq '*'){return $true}
        if($entry -match '^[a-z0-9.-]+(?::[0-9]+)?$') {
            $hostPart=$entry;$portPart=''
            if($entry.Contains(':')){$hostPart=$entry.Split(':')[0];$portPart=$entry.Split(':')[1]}
            if($portPart -and [int]$portPart -ne $Uri.Port){continue}
            $hostPart=$hostPart.TrimStart('.');$destinationHost=$Uri.DnsSafeHost.ToLowerInvariant()
            if($destinationHost -eq $hostPart -or $destinationHost.EndsWith('.'+$hostPart)){return $true}
        } else { throw 'SETUP_PROXY_INPUT: NO_PROXYはcomma区切りのhost/domain[:port]または * に対応します。' }
    }
    return $false
}
function New-SetupHttpHandler([hashtable]$Policy,[Uri]$Destination) {
    $handler=[Net.Http.HttpClientHandler]::new();$handler.UseDefaultCredentials=$false;$handler.Credentials=$null;$handler.AllowAutoRedirect=$false
    if($Policy.Mode -eq 'proxy' -and (Test-SetupNoProxy $Destination $Policy.NoProxy)) { $handler.UseProxy=$false }
    else {
        $handler.UseProxy=$true
        if($Policy.Mode -eq 'proxy'){$proxy=[Net.WebProxy]::new($Policy.ProxyUri,$false)}else{$proxy=[Net.WebRequest]::GetSystemWebProxy()}
        if($Policy.Authentication -eq 'windows'){Initialize-SetupProxyCredentials;$proxy.Credentials=New-Object RadarSetup.ProxyWindowsCredentials}else{$proxy.Credentials=$null}
        $handler.Proxy=$proxy
    }
    return $handler
}
function Get-SetupNetworkFailure($Failure) {
    $e=$Failure.Exception
    while($e) {
        if($e -is [OperationCanceledException]){return 'SETUP_NETWORK_TIMEOUT: ダウンロードが時間内に完了しませんでした。proxyの到達性と社内許可を確認してください。'}
        if($e -is [Net.WebException]) {
            if($e.Response -is [Net.HttpWebResponse] -and [int]$e.Response.StatusCode -eq 407){return (Get-SetupProxyAuthMessage)}
            if($e.Status -in @([Net.WebExceptionStatus]::TrustFailure,[Net.WebExceptionStatus]::SecureChannelFailure)){return 'SETUP_NETWORK_TLS: TLS証明書または安全な接続の検証に失敗しました。SSL検証は無効にしません。社内ITへ証明書/許可先を確認してください。'}
            if($e.Status -in @([Net.WebExceptionStatus]::NameResolutionFailure,[Net.WebExceptionStatus]::ProxyNameResolutionFailure)){return 'SETUP_NETWORK_DNS: 配布元またはproxyの名前解決に失敗しました。Windowsのproxy設定を確認してください。'}
            if($e.Status -eq [Net.WebExceptionStatus]::Timeout){return 'SETUP_NETWORK_TIMEOUT: proxy/配布元からの応答が時間切れです。'}
        }
        $e=$e.InnerException
    }
    return 'SETUP_NETWORK_CONNECT: 配布元/proxyに接続できませんでした。proxy設定・社内の接続許可を確認してください。URLや認証情報はログへ表示していません。'
}
function Get-SetupProxyAuthMessage {
    return 'SETUP_PROXY_AUTH_REQUIRED: proxy認証(407)が必要です。Windowsにproxy登録済みなら setup.cmd -UseSystemProxy -ProxyUseDefaultCredentials を試してください。NTLM/Negotiate等のWindows統合認証のみ対応し、Basic専用proxyのパスワードは収集・保存しません。解決しない場合は社内ITへ確認するか許可されたoffline ZIPを使ってください。'
}
function Invoke-SetupDownload {
    param([Uri]$Uri,[string]$OutFile,[hashtable]$Policy,[int]$TimeoutSeconds=180)
    $cancel=[Threading.CancellationTokenSource]::new();$cancel.CancelAfter($TimeoutSeconds*1000);$current=$Uri
    try {
        for($redirect=0;$redirect -le 5;$redirect++) {
            $handler=New-SetupHttpHandler $Policy $current;$client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[Threading.Timeout]::InfiniteTimeSpan;$response=$null;$stream=$null;$file=$null
            try {
                $response=$client.GetAsync($current,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
                $status=[int]$response.StatusCode
                if($status -eq 407){throw (Get-SetupProxyAuthMessage)}
                if($status -in @(301,302,303,307,308)) {
                    $next=[Uri]::new($current,$response.Headers.Location)
                    if($next.UserInfo -or $next.Scheme -notin @('http','https') -or ($current.Scheme -eq 'https' -and $next.Scheme -ne 'https')){throw 'SETUP_NETWORK_REDIRECT: 安全なHTTPS転送先を確認できませんでした。'}
                    $current=$next;continue
                }
                if(-not $response.IsSuccessStatusCode){throw ('SETUP_NETWORK_HTTP: HTTP '+$status+'。配布元/proxyの接続許可を社内ITへ確認してください。')}
                $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult();$file=[IO.File]::Open($OutFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                [void]$stream.CopyToAsync($file,81920,$cancel.Token).GetAwaiter().GetResult();$file.Flush($true);return
            } finally {if($file){$file.Dispose()};if($stream){$stream.Dispose()};if($response){$response.Dispose()};$client.Dispose()}
        }
        throw 'SETUP_NETWORK_REDIRECT: 転送回数が上限を超えました。'
    } catch {
        if($_.Exception.Message -match '^SETUP_'){throw $_.Exception.Message}
        throw (Get-SetupNetworkFailure $_)
    } finally {$cancel.Dispose()}
}
