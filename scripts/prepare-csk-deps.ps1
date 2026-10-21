$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
$gitExe = if ($gitCommand) { $gitCommand.Source } else { 'C:\Program Files\Git\cmd\git.exe' }
if (-not (Test-Path -LiteralPath $gitExe)) { throw 'Git is required.' }
# Public manufacturer source only. No devices, global settings or firmware writes.
$specs = @(
    @('csk-raw-reference','mtb-example-psoc6-cmos-radar-people-tracking','f6e9c82b28d0022790b0905201e1d6720615063d'),
    @('csk-bsp','TARGET_CYSBSYSKIT-DEV-01','31a74fb58cc31faf658690a68de2918bf0314be1'),
    @('csk-bsp-v2','TARGET_CYSBSYSKIT-DEV-01','6afd3dd851bec439a8582c1eed25b54c4052018e'),
    @('csk-pdl','mtb-pdl-cat1','7824cbb180850f74933aed2dbab139e47221ae2b'),
    @('csk-hal','mtb-hal-cat1','c2558131d294accb006048208d1bb4b625a767d9'),
    @('csk-core-lib','core-lib','ca57d1e519e08badec6891d1776c7b4f05e09561'),
    @('csk-cmsis','cmsis','ce02f641ebc22103402260f9bb95698fd14086f1'),
    @('csk-sensor-driver','sensor-xensiv-bgt60cutrxx','04c4f5e8419d72504db3da316f285aa12267ae43'),
    @('csk-cm0p','cat1cm0p','b2f7229c959a94251e0c436602c0e81de0ebdbc8')
)
foreach ($spec in $specs) {
    $targetPath = Join-Path $runtimeRoot $spec[0]
    if (Test-Path -LiteralPath $targetPath) {
        $actual = & $gitExe -C $targetPath rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or $actual -ne $spec[2]) { throw "Existing dependency differs: $targetPath. Preserve it and choose a clean workspace." }
        Write-Output "Pinned dependency already present: $($spec[0])"
        continue
    }
    & $gitExe init $targetPath
    if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
    & $gitExe -C $targetPath remote add origin "https://github.com/Infineon/$($spec[1]).git"
    if ($LASTEXITCODE -ne 0) { throw 'git remote failed' }
    & $gitExe -C $targetPath fetch --depth 1 origin $spec[2]
    if ($LASTEXITCODE -ne 0) { throw "Dependency fetch failed: $($spec[0])" }
    & $gitExe -C $targetPath checkout --detach $spec[2]
    if ($LASTEXITCODE -ne 0) { throw "Dependency checkout failed: $($spec[0])" }
}
