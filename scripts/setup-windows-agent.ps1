$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath('Startup')
$directory = Join-Path $env:LOCALAPPDATA 'NaukriAutomation'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
# Per-user Startup shortcut; no service, administrator, scheduled task or inbound port.
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $startup 'Naukri Agent.lnk'))
$link.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$link.Arguments = '-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'agent-supervisor.ps1') + '"'
$link.WorkingDirectory = $root
$link.WindowStyle = 7
$link.Description = 'Start the local Naukri agent after Windows sign-in'
$link.Save()
Write-Output 'Startup launcher installed for this Windows user. Keep this checkout in its current location. It starts at your next sign-in.'
