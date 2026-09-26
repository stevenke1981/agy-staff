#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Repository = $PSScriptRoot,
    [string]$GeminiBridge, [string]$GrokBridge, [string]$ChatGPTBridge,
    [string]$AgyBin, [string]$FFmpeg, [string]$FFprobe,
    [ValidateSet('gemini-bridge','grok-bridge','chatgpt-bridge','agy-native')]
    [string]$CheckProvider = 'gemini-bridge'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$Cli = Join-Path $Repository 'companion\codex-staff.mjs'
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) { throw 'Apply/upgrade codex.3 first; repository entrypoint was not found.' }
$Record = Get-Content -LiteralPath (Join-Path $Repository '.agy-codex-adaptation.json') -Raw | ConvertFrom-Json
if ($Record.version -ne '0.7.3-codex.3') { throw 'This setup requires codex.3.' }
$Argv = @($Cli, 'media', 'configure', '--auto-detect')
$Pairs = @{'--gemini-bin'=$GeminiBridge; '--grok-bin'=$GrokBridge; '--chatgpt-bin'=$ChatGPTBridge; '--agy-bin'=$AgyBin; '--ffmpeg'=$FFmpeg; '--ffprobe'=$FFprobe}
foreach ($Pair in $Pairs.GetEnumerator()) { if ($Pair.Value) { $Argv += @($Pair.Key, $Pair.Value) } }
& $Node @Argv
if ($LASTEXITCODE -ne 0) { throw 'Media configuration failed. No generation was submitted.' }
$Lines = & $Node $Cli media doctor --provider $CheckProvider
if ($LASTEXITCODE -ne 0) { throw 'Media doctor could not complete.' }
$Text = $Lines -join "`n"
Write-Output $Text
$Report = $Text | ConvertFrom-Json
$Provider = $Report.providers.PSObject.Properties[$CheckProvider].Value
if (-not $Report.technical.ffmpeg -or -not $Report.technical.ffprobe) { throw 'FFmpeg and ffprobe are required; configure both native executables, then rerun setup.' }
if (-not $Provider.available) { throw 'Provider is not ready. Open Chrome, enable the relevant Bridge and log in, or fix the native AGY path. This setup did not generate anything.' }
Write-Host 'Media routing configured. No media generated, no account switched, no global Codex/MCP settings changed. Live generation still requires an explicit user task.'
