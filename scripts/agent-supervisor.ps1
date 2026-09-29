$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $env:LOCALAPPDATA 'NaukriAutomation'
$logs = Join-Path $directory 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'supervisor.log'
$node = (Get-Command node -ErrorAction Stop).Source
Set-Location -LiteralPath $root
while (-not (Test-Path (Join-Path $directory 'agent.stop'))) {
    # The agent writes allowlisted structured logs itself. Discard raw process output.
    & $node '--env-file-if-exists=.env' (Join-Path $PSScriptRoot 'windows-agent.ts') *> $null
    $code = $LASTEXITCODE
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1000000) { Move-Item -Force $log "$log.1" }
    Add-Content -Path $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' agent-exited code=' + [int]$code)
    Start-Sleep -Seconds 30
}
