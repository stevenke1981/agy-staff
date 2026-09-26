#Requires -Version 5.1
<# One-time Windows x64 setup. Downloads pinned CLIProxyAPI only when -ProxyBin is omitted.
Checks the release SHA256, obtains browser OAuth for each alias, then runs a live smoke
per account before enabling automatic selection. Does not change native Google/Codex login.
PowerShell and real Google calls are not validated by the Linux offline test suite. #>
[CmdletBinding()]
param(
    [string]$Repository = $PSScriptRoot,
    [string[]]$Accounts = @('google-1', 'google-2'),
    [string]$ProxyBin,
    [string]$Model
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows.' }
$Node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$Marker = Join-Path $Repository '.agy-codex-adaptation.json'
if (-not (Test-Path -LiteralPath $Marker)) { throw 'Apply or upgrade the adaptation first.' }
if ((Get-Content -LiteralPath $Marker -Raw -Encoding UTF8 | ConvertFrom-Json).version -ne '0.7.3-codex.3') { throw 'This script requires codex.3.' }
foreach ($Alias in $Accounts) {
    if ($Alias -notmatch '^[a-z][a-z0-9_-]{0,39}$') { throw "Invalid alias: $Alias" }
}
if ($Accounts.Count -lt 1 -or (@($Accounts | Select-Object -Unique)).Count -ne $Accounts.Count) { throw 'Supply unique account aliases.' }
$Cli = Join-Path $Repository 'companion\codex-staff.mjs'
function Invoke-Staff([string[]]$Arguments) {
    & $Node $Cli @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Account step failed ($LASTEXITCODE). Auto selection was not newly enabled." }
}
$Pool = if ($env:AGY_STAFF_ACCOUNTS_DIR) { [IO.Path]::GetFullPath($env:AGY_STAFF_ACCOUNTS_DIR) } else { Join-Path $env:LOCALAPPDATA 'agy-staff\accounts' }
$Registry = Join-Path $Pool 'registry.json'
if (Test-Path -LiteralPath $Registry) {
    $Saved = Get-Content -LiteralPath $Registry -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ProxyBin -and [IO.Path]::GetFullPath($ProxyBin) -ne $Saved.proxyBin) { throw 'An existing registry uses another proxy binary; no configuration was overwritten.' }
    $ProxyBin = $Saved.proxyBin
} elseif (-not $ProxyBin) {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Automatic download supports Windows x64 only; supply -ProxyBin for your platform.' }
    $Tag = 'v7.3.17'
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/$Tag" -Headers @{ 'User-Agent' = 'agy-staff-codex-setup'; 'Accept' = 'application/vnd.github+json' }
    $Matches = @($Release.assets | Where-Object { $_.name -eq 'CLIProxyAPI_7.3.17_windows_amd64.zip' })
    if ($Matches.Count -ne 1) { throw 'Pinned Windows x64 release asset not found. No alternate binary was downloaded.' }
    $Asset = $Matches[0]
    if ($Asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'Release asset has no SHA256 digest; download refused.' }
    $Expected = '3a036376a7c04a8fe70d7335915aa79cc520f8fad72030ef8da43a64e50bc38b'
    if ($Asset.digest.Substring(7).ToLowerInvariant() -ne $Expected) { throw 'Pinned release digest changed since review; automatic download refused.' }
    $Stage = Join-Path $env:TEMP ('agy-proxy-download-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($Stage) | Out-Null
    try {
        $Archive = Join-Path $Stage 'proxy.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $Asset.browser_download_url -OutFile $Archive
        if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'CLIProxyAPI archive SHA256 mismatch.' }
        Expand-Archive -LiteralPath $Archive -DestinationPath (Join-Path $Stage 'unpacked')
        $Executables = @(Get-ChildItem -LiteralPath (Join-Path $Stage 'unpacked') -Filter '*.exe' -Recurse -File)
        if ($Executables.Count -ne 1) { throw 'Expected one native executable in the pinned release.' }
        $Install = Join-Path $env:LOCALAPPDATA ('agy-staff\bin\CLIProxyAPI-' + $Tag + '-' + $Expected.Substring(0,12))
        [IO.Directory]::CreateDirectory($Install) | Out-Null
        $ProxyBin = Join-Path $Install $Executables[0].Name
        if (Test-Path -LiteralPath $ProxyBin) {
            if ((Get-FileHash -LiteralPath $ProxyBin).Hash -ne (Get-FileHash -LiteralPath $Executables[0].FullName).Hash) { throw 'Existing proxy executable differs; not overwritten.' }
        } else { Copy-Item -LiteralPath $Executables[0].FullName -Destination $ProxyBin }
    } finally { Remove-Item -LiteralPath $Stage -Recurse -Force }
}
if (-not (Test-Path -LiteralPath $ProxyBin -PathType Leaf)) { throw 'CLIProxyAPI executable is missing.' }
if (-not (Test-Path -LiteralPath $Registry)) { Invoke-Staff @('accounts', 'init', '--proxy-bin', ([IO.Path]::GetFullPath($ProxyBin))) }
foreach ($Alias in $Accounts) {
    Write-Host "Complete Google browser login for alias: $Alias. Select a different authorized account for each alias."
    Invoke-Staff @('accounts', 'login', $Alias)
    $Smoke = @('ask', '--workspace', $Repository, '--account', $Alias, '--prompt', 'Reply exactly ACCOUNT_OK. Do not use tools.', '--timeout', '2m')
    if ($Model) { $Smoke += @('--model', $Model) }
    Invoke-Staff $Smoke
}
Invoke-Staff @('accounts', 'use', 'auto')
Invoke-Staff @('accounts', 'list')
Write-Host 'Live smoke passed for each selected account. Automatic selection is now the local default.'
