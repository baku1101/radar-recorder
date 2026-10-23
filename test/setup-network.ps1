param([int]$ProxyPort,[int]$OriginPort,[string]$ResultFile,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\setup-network.ps1')
$checks=New-Object Collections.Generic.List[string]
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw ('FAIL '+$Name)};$checks.Add($Name);Write-Host ('PASS '+$Name)}
function ExpectFailure([scriptblock]$Call,[string]$Code){try{& $Call;throw 'Expected failure'}catch{if($_.Exception.Message -notmatch $Code){throw ('Wrong failure category: '+$Code)}}}
$saved=@{};foreach($n in @('HTTPS_PROXY','HTTP_PROXY','NO_PROXY')){$saved[$n]=[Environment]::GetEnvironmentVariable($n,'Process');[Environment]::SetEnvironmentVariable($n,$null,'Process')}
$file=Join-Path $FixtureRoot 'setup-network.local.json';$uri=[Uri]'http://setup-test.invalid/package';$address='http://127.0.0.1:'+$ProxyPort
try {
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot;Check ($p.Mode -eq 'system' -and $p.Authentication -eq 'none') 'Default selects Windows proxy/PAC without enabling authentication'
    $env:HTTP_PROXY='http://http.example.invalid:8080';$env:HTTPS_PROXY='http://https.example.invalid:8080';$env:NO_PROXY='.example.test:8080,localhost'
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot;Check ($p.Source -eq 'HTTPS_PROXY') 'HTTPS_PROXY precedes HTTP_PROXY'
    $env:HTTPS_PROXY=$null;$p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot;Check ($p.Source -eq 'HTTP_PROXY') 'HTTP_PROXY fallback is explicit'
    Check ((Test-SetupNoProxy ([Uri]'http://sub.example.test:8080/x') $p.NoProxy) -and -not (Test-SetupNoProxy ([Uri]'http://example.test:8081/x') $p.NoProxy)) 'NO_PROXY host/domain/port matching does not broaden a different port'
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot -Proxy $address;Check ($p.Source -eq 'command line' -and -not $p.NoProxy) 'Explicit proxy wins environment and does not silently inherit its bypass'
    [IO.File]::WriteAllText($file,'{"schema_version":1,"mode":"system","proxy":"","authentication":"none"}')
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot;Check ($p.Mode -eq 'system' -and $p.Source -eq 'app-local settings') 'App-local settings override inherited environment'
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot -Proxy $address -ProxyUseDefaultCredentials;Check ($p.Mode -eq 'proxy' -and $p.Authentication -eq 'windows') 'Command line overrides local settings and selects proxy-only Windows auth'
    Remove-Item -LiteralPath $file
    foreach($bad in @('http://synthetic-user:synthetic-secret@127.0.0.1:8080','http://proxy.invalid/?token=synthetic-token','socks5://proxy.invalid:8080')){try{Assert-SetupProxyUri $bad;throw 'Expected input refusal'}catch{Check ($_.Exception.Message -match 'SETUP_PROXY_INPUT' -and $_.Exception.Message -notmatch 'synthetic-(?:user|secret|token)') 'Unsafe proxy URL rejected without echoing credentials or token'}}
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot -Proxy $address -ProxyUseDefaultCredentials;$h=New-SetupHttpHandler $p $uri
    try {Check (-not $h.UseDefaultCredentials -and $null -eq $h.Credentials -and $null -eq $h.Proxy.Credentials.GetCredential($uri,'Basic') -and $null -ne $h.Proxy.Credentials.GetCredential($uri,'Negotiate')) 'Windows credentials restricted to proxy integrated schemes; origin and Basic receive none'}finally{$h.Dispose()}
    $p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot -Proxy $address;$out=Join-Path $FixtureRoot 'download.part';Invoke-SetupDownload -Uri $uri -OutFile $out -Policy $p -TimeoutSeconds 5
    Check ([IO.File]::ReadAllText($out) -eq 'synthetic package bytes') 'Actual HTTP fixture is obtained through the selected loopback proxy'
    Remove-Item -LiteralPath $out
    ExpectFailure {Invoke-SetupDownload -Uri ('http://setup-test.invalid/auth407') -OutFile $out -Policy $p -TimeoutSeconds 5} 'SETUP_PROXY_AUTH_REQUIRED'
    Check (-not (Test-Path -LiteralPath $out)) '407 is categorized before writing a package'
    ExpectFailure {Invoke-SetupDownload -Uri ('https://setup-test.invalid/auth407') -OutFile $out -Policy $p -TimeoutSeconds 5} 'SETUP_PROXY_AUTH_REQUIRED'
    Check (-not (Test-Path -LiteralPath $out)) 'HTTPS CONNECT proxy 407 has the same actionable category'
    $integrated=Get-SetupNetworkPolicy -AppRoot $FixtureRoot -Proxy $address -ProxyUseDefaultCredentials
    ExpectFailure {Invoke-SetupDownload -Uri ('http://setup-test.invalid/origin401') -OutFile $out -Policy $integrated -TimeoutSeconds 5} 'SETUP_NETWORK_HTTP: HTTP 401'
    Check (-not (Test-Path -LiteralPath $out)) 'Origin 401 cannot use proxy-scoped Windows credentials'
    ExpectFailure {Invoke-SetupDownload -Uri ('http://setup-test.invalid/denied') -OutFile $out -Policy $p -TimeoutSeconds 5} 'SETUP_NETWORK_HTTP: HTTP 403'
    Check $true 'Access denial does not fall back to direct access or another mirror'
    ExpectFailure {Invoke-SetupDownload -Uri ('http://setup-test.invalid/slow') -OutFile $out -Policy $p -TimeoutSeconds 1} 'SETUP_NETWORK_TIMEOUT'
    Check $true 'Download timeout is bounded and categorized'
    $env:HTTPS_PROXY=$address;$env:NO_PROXY='127.0.0.1';$p=Get-SetupNetworkPolicy -AppRoot $FixtureRoot;$direct=[Uri]('http://127.0.0.1:'+$OriginPort+'/package');$h=New-SetupHttpHandler $p $direct
    try{Check (-not $h.UseProxy) 'NO_PROXY selects direct access only for its explicitly matched destination'}finally{$h.Dispose()}
    Invoke-SetupDownload -Uri $direct -OutFile $out -Policy $p -TimeoutSeconds 5;Check ([IO.File]::ReadAllText($out) -eq 'direct synthetic bytes') 'NO_PROXY fixture follows the selected direct route';Remove-Item -LiteralPath $out
    foreach($entry in @(@([Net.WebExceptionStatus]::TrustFailure,'SETUP_NETWORK_TLS'),@([Net.WebExceptionStatus]::NameResolutionFailure,'SETUP_NETWORK_DNS'))){$e=[Net.WebException]::new('private diagnostic text not for display',$entry[0]);$m=Get-SetupNetworkFailure @{Exception=$e};Check ($m -match $entry[1] -and $m -notmatch 'private diagnostic') 'TLS/DNS category suppresses raw exception text'}
    @{passed=$true;checks=$checks.ToArray();company_proxy_tested=$false;windows_integrated_auth_server_tested=$false;pac_server_tested=$false;hardware_used=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $ResultFile -Encoding UTF8
} finally {foreach($n in $saved.Keys){[Environment]::SetEnvironmentVariable($n,$saved[$n],'Process')}}
