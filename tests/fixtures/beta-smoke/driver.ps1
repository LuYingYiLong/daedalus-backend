$ErrorActionPreference = "Stop"

function Write-SmokeEvent($Event) {
	$Event | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $env:SMOKE_EVENTS_PATH
}

function Start-Process {
	param($FilePath, $ArgumentList, $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru, $WindowStyle)
	Write-SmokeEvent @{ kind = "start"; windowStyle = $WindowStyle; userProfile = $env:USERPROFILE; arguments = $ArgumentList }
	return [pscustomobject]@{ Id = 123; HasExited = ($env:SMOKE_BACKEND_EXITED -eq "1") }
}

function Stop-Process {
	param($Id, [switch]$Force)
	Write-SmokeEvent @{ kind = "stop"; id = $Id }
}

function npm {
	Write-SmokeEvent @{ kind = "ping"; url = $env:WS_URL; arguments = $args }
	$global:LASTEXITCODE = 0
}

$exitCode = 0
try {
	& $env:SMOKE_SCRIPT_PATH
} catch {
	Write-Host $_
	$exitCode = 1
} finally {
	Write-SmokeEvent @{ kind = "restored"; userProfile = $env:USERPROFILE; appData = $env:APPDATA; port = $env:PORT; url = $env:WS_URL }
}
exit $exitCode
