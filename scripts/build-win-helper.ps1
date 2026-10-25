$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$HelperProject = Join-Path $ProjectRoot "resources/helpers/windows/WindowsMicWatcher.csproj"
$BinDir = Join-Path $ProjectRoot "resources/bin"

Write-Host "Building Windows mic watcher helper..."

$targets = @(
    @{ Runtime = "win-x64"; Output = "win32-x64" },
    @{ Runtime = "win-arm64"; Output = "win32-arm64" }
)

foreach ($target in $targets) {
    $publishDir = Join-Path $BinDir $target.Output
    New-Item -ItemType Directory -Force -Path $publishDir | Out-Null

    Write-Host "Publishing for $($target.Runtime)..."
    dotnet publish $HelperProject `
        -c Release `
        -r $target.Runtime `
        --self-contained true `
        /p:PublishSingleFile=true `
        /p:PublishTrimmed=false `
        -o $publishDir

    # Native command failures do not trigger $ErrorActionPreference in Windows PowerShell 5.1.
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed for $($target.Runtime) (exit code $LASTEXITCODE). Install the .NET 8 SDK."
    }
    $helperExe = Join-Path $publishDir "win-mic-watcher.exe"
    if (-not (Test-Path $helperExe)) {
        throw "Expected helper was not produced: $helperExe"
    }
}

Write-Host "Done. Helpers published under resources/bin/win32-x64 and resources/bin/win32-arm64."
