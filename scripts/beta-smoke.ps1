param(
	[string]$GodotExecutablePath = $env:GODOT_EXECUTABLE_PATH,
	[string]$GodotProjectPath = $env:GODOT_PROJECT_PATH,
	[string]$BridgeDir = $env:DAEDALUS_BRIDGE_DIR,
	[int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 38180 }),
	[int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($GodotExecutablePath)) {
	throw "Set GODOT_EXECUTABLE_PATH or pass -GodotExecutablePath to the Godot executable."
}

if ([string]::IsNullOrWhiteSpace($GodotProjectPath)) {
	throw "Set GODOT_PROJECT_PATH or pass -GodotProjectPath to a project containing Daedalus Bridge."
}

if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
	$BridgeDir = Join-Path $GodotProjectPath "addons\daedalus_bridge"
}

if (-not (Test-Path -LiteralPath $GodotExecutablePath -PathType Leaf)) {
	throw "Godot executable was not found: $GodotExecutablePath"
}

if (-not (Test-Path -LiteralPath $GodotProjectPath -PathType Container)) {
	throw "Godot project was not found: $GodotProjectPath"
}

$GodotProjectPath = (Resolve-Path -LiteralPath $GodotProjectPath).Path
$expectedBridgeDir = [IO.Path]::GetFullPath((Join-Path $GodotProjectPath "addons\daedalus_bridge"))
if ([IO.Path]::GetFullPath($BridgeDir).TrimEnd('\', '/') -ne $expectedBridgeDir) {
	throw "DAEDALUS_BRIDGE_DIR must point to addons/daedalus_bridge inside GODOT_PROJECT_PATH."
}
$BridgeDir = $expectedBridgeDir

foreach ($requiredFile in @(
	(Join-Path $GodotProjectPath "project.godot"),
	(Join-Path $BridgeDir "plugin.cfg"),
	(Join-Path $BridgeDir "daedalus_bridge.gd"),
	(Join-Path $BridgeDir "scripts\bridge_runtime.gd"),
	(Join-Path $BridgeDir "scripts\editor_context.gd")
)) {
	if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
		throw "Required Daedalus Bridge smoke file was not found: $requiredFile"
	}
}

$backendUrl = "ws://127.0.0.1:$Port"
$logDir = Join-Path ([IO.Path]::GetTempPath()) ("daedalus-beta-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backendLog = Join-Path $logDir ("backend-{0}.stdout.log" -f $logStamp)
$backendErrorLog = Join-Path $logDir ("backend-{0}.stderr.log" -f $logStamp)

function Write-BackendLogs {
	param(
		[string]$Label
	)

	foreach ($stream in @(
		@{ Name = "stdout"; Path = $backendLog },
		@{ Name = "stderr"; Path = $backendErrorLog }
	)) {
		Write-Host "Backend $Label $($stream.Name) log: $($stream.Path)"
		if (Test-Path -LiteralPath $stream.Path -PathType Leaf) {
			Get-Content -LiteralPath $stream.Path -Raw | Write-Host
		} else {
			Write-Host "(log file was not created)"
		}
	}
}

function Invoke-GodotSmokeCommand {
	param(
		[string]$Label,
		[string[]]$GodotArguments
	)

	Write-Host "Running $Label"
	$output = & $GodotExecutablePath @GodotArguments 2>&1
	$exitCode = $LASTEXITCODE
	$text = ($output | Out-String)
	if ($text.Trim().Length -gt 0) {
		Write-Host $text
	}

	if ($exitCode -ne 0) {
		throw "$Label failed with exit code $exitCode."
	}

	if ($text -match "SCRIPT ERROR|\bERROR:") {
		throw "$Label emitted Godot errors."
	}
}

Write-Host "Starting backend on $backendUrl"
$savedEnvironment = @{}
foreach ($name in @("PORT", "WS_URL", "USERPROFILE", "APPDATA")) {
	$savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$smokeUserProfile = Join-Path $logDir "userprofile"
New-Item -ItemType Directory -Path $smokeUserProfile | Out-Null
$smokeAppData = Join-Path $logDir "appdata"
New-Item -ItemType Directory -Path $smokeAppData | Out-Null
$env:PORT = [string]$Port
$env:USERPROFILE = $smokeUserProfile
$env:APPDATA = $smokeAppData
$backendProcess = $null
try {
	$backendProcess = Start-Process -FilePath (Get-Command node).Source `
		-ArgumentList @("--import", "tsx", "src/cli.ts", "serve") `
		-WorkingDirectory (Get-Location).Path `
		-RedirectStandardOutput $backendLog `
		-RedirectStandardError $backendErrorLog `
		-PassThru `
		-WindowStyle Hidden

	$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
	$healthy = $false
	while ((Get-Date) -lt $deadline) {
		if ($backendProcess.HasExited) {
			Write-BackendLogs -Label "startup failure"
			throw "Backend exited before becoming healthy."
		}
		$env:WS_URL = $backendUrl
		npm run --silent ping *> $null
		if ($LASTEXITCODE -eq 0) {
			$healthy = $true
			break
		}
		Start-Sleep -Milliseconds 500
	}

	if (-not $healthy) {
		Write-BackendLogs -Label "startup failure"
		throw "Backend did not become healthy before timeout. Logs: $backendLog ; $backendErrorLog"
	}

	Write-Host "Running Daedalus Bridge script checks"
	$bridgeScripts = Get-ChildItem -LiteralPath $BridgeDir -Filter "*.gd" -File -Recurse | Sort-Object FullName
	foreach ($bridgeScript in $bridgeScripts) {
		$relativePath = [IO.Path]::GetRelativePath($GodotProjectPath, $bridgeScript.FullName).Replace('\', '/')
		Invoke-GodotSmokeCommand `
			-Label "$relativePath check-only" `
			-GodotArguments @("--headless", "--path", $GodotProjectPath, "--check-only", "--script", "res://$relativePath")
	}

	Write-Host "Beta smoke passed. Backend logs: $backendLog ; $backendErrorLog"
} finally {
	if ($null -ne $backendProcess -and -not $backendProcess.HasExited) {
		Stop-Process -Id $backendProcess.Id -Force
	}
	foreach ($name in $savedEnvironment.Keys) {
		[Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
	}
}
