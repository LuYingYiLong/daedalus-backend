param(
    [string]$OutputPath = "$(Join-Path (Join-Path $PSScriptRoot "..") "build\daedalus-windows-sandbox-helper.exe")"
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourcePath = Join-Path $projectRoot "native\windows-sandbox-helper\main.cpp"
$outputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Windows sandbox helper source is missing: $sourcePath"
}

$clPath = $null
$vcvarsPath = $null
$visualStudioRoots = @(
    "${env:ProgramFiles}\Microsoft Visual Studio",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio"
)
foreach ($root in $visualStudioRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter "cl.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\cl\.exe$" } |
        Select-Object -First 1
    if ($null -ne $candidate) {
        $clPath = $candidate.FullName
        $vcvarsPath = Join-Path $candidate.Directory.Parent.Parent.Parent.Parent.Parent.Parent.FullName "Auxiliary\Build\vcvars64.bat"
        break
    }
}
if ($null -eq $clPath -or -not (Test-Path -LiteralPath $vcvarsPath -PathType Leaf)) {
    throw "Visual Studio x64 C++ build tools are required to build the Windows sandbox helper."
}

$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$sourceRelative = [System.IO.Path]::GetRelativePath($projectRoot, $sourcePath)
$outputRelative = [System.IO.Path]::GetRelativePath($projectRoot, $outputPath)
$compileCommand = "cl.exe /nologo /std:c++20 /O2 /EHsc /D_WIN32_WINNT=0x0A00 `"$sourceRelative`" /Fe:`"$outputRelative`" /link /SUBSYSTEM:CONSOLE OneCore.lib"
& cmd.exe /d /s /c "call `"$vcvarsPath`" && $compileCommand"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "Windows sandbox helper compilation failed."
}

Write-Output "Built Windows sandbox helper: $outputPath"
