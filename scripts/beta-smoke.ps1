param(
	[string]$GodotExecutablePath = $env:GODOT_EXECUTABLE_PATH,
	[string]$GodotProjectPath = $(if ($env:GODOT_PROJECT_PATH) { $env:GODOT_PROJECT_PATH } else { "D:\GodotProjects\example" }),
	[string]$PluginDir = $(if ($env:GODOT_DAEDALUS_PLUGIN_DIR) { $env:GODOT_DAEDALUS_PLUGIN_DIR } else { "D:\GodotProjects\example\addons\godot_daedalus" }),
	[int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 38180 }),
	[int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($GodotExecutablePath)) {
	$GodotExecutablePath = "D:\Godot_v4.7-stable_win64.exe\Godot_v4.7-stable_win64.exe"
}

if (-not (Test-Path -LiteralPath $GodotExecutablePath -PathType Leaf)) {
	throw "Godot executable was not found: $GodotExecutablePath"
}

if (-not (Test-Path -LiteralPath $GodotProjectPath -PathType Container)) {
	throw "Godot project was not found: $GodotProjectPath"
}

if (-not (Test-Path -LiteralPath $PluginDir -PathType Container)) {
	throw "Godot Daedalus plugin directory was not found: $PluginDir"
}

$backendUrl = "ws://localhost:$Port"
$logDir = Join-Path $env:TEMP "godot-daedalus-beta-smoke"
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
$env:PORT = [string]$Port
$backendProcess = Start-Process -FilePath (Get-Command node).Source `
	-ArgumentList @("--import", "tsx", "src/cli.ts", "serve") `
	-WorkingDirectory (Get-Location).Path `
	-RedirectStandardOutput $backendLog `
	-RedirectStandardError $backendErrorLog `
	-PassThru `
	-WindowStyle Hidden

try {
	$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
	$healthy = $false
	while ((Get-Date) -lt $deadline) {
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

	Write-Host "Running Godot plugin checks"
	Invoke-GodotSmokeCommand `
		-Label "main.gd check-only" `
		-GodotArguments @("--headless", "--path", $GodotProjectPath, "--check-only", "--script", "res://addons/godot_daedalus/scripts/main.gd")

	$pluginTestsDir = Join-Path $PluginDir "tests"
	if (-not (Test-Path -LiteralPath $pluginTestsDir -PathType Container)) {
		throw "Godot Daedalus plugin tests directory was not found: $pluginTestsDir"
	}

	$pluginTests = Get-ChildItem -LiteralPath $pluginTestsDir -Filter "*.gd" |
		Where-Object { $_.Name -ne "backend_websocket_smoke_test.gd" } |
		Sort-Object Name
	foreach ($pluginTest in $pluginTests) {
		$resourcePath = "res://addons/godot_daedalus/tests/$($pluginTest.Name)"
		Invoke-GodotSmokeCommand `
			-Label $pluginTest.Name `
			-GodotArguments @("--headless", "--path", $GodotProjectPath, "--script", $resourcePath)
	}

	$env:DAEDALUS_TEST_BACKEND_URL = $backendUrl
	Invoke-GodotSmokeCommand `
		-Label "backend_websocket_smoke_test.gd" `
		-GodotArguments @("--headless", "--path", $GodotProjectPath, "--script", "res://addons/godot_daedalus/tests/backend_websocket_smoke_test.gd")

	Write-Host "Beta smoke passed. Backend logs: $backendLog ; $backendErrorLog"
} finally {
	if ($null -ne $backendProcess -and -not $backendProcess.HasExited) {
		Stop-Process -Id $backendProcess.Id -Force
	}
	Remove-Item Env:\WS_URL -ErrorAction SilentlyContinue
	Remove-Item Env:\DAEDALUS_TEST_BACKEND_URL -ErrorAction SilentlyContinue
}
