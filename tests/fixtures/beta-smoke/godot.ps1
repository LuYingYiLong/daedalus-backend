@{ kind = "godot"; arguments = $args; appData = $env:APPDATA } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:SMOKE_EVENTS_PATH
if ($env:SMOKE_GODOT_ERROR -eq "1") {
	Write-Output "SCRIPT ERROR: Parse Error: fixture"
}
$global:LASTEXITCODE = [int]$env:SMOKE_GODOT_EXIT_CODE
