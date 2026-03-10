param(
    [switch]$NoStart,
    [switch]$Detached
)

$ErrorActionPreference = "Stop"

function Load-DotEnvFile([string]$Path) {
    if (-not (Test-Path $Path)) {
        Write-Host "[restart-tts] .env not found at: $Path"
        return
    }

    Write-Host "[restart-tts] Loading env from $Path"
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') { return }

        $parts = $line -split "=", 2
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

function Get-PidsOnPort([int]$Port) {
    $pids = @()
    $lines = netstat -ano | Select-String ":$Port"
    foreach ($line in $lines) {
        $text = ($line.ToString() -replace "\s+", " ").Trim()
        # Example: TCP 0.0.0.0:8880 0.0.0.0:0 LISTENING 12345
        $parts = $text.Split(" ")
        if ($parts.Length -ge 5) {
            $state = $parts[3]
            $procId = $parts[4]
            if ($state -eq "LISTENING" -and $procId -match "^\d+$") {
                $pids += [int]$procId
            }
        }
    }
    return $pids | Select-Object -Unique
}

function Stop-TtsProcesses {
    $targets = Get-PidsOnPort -Port 8880
    if (-not $targets -or $targets.Count -eq 0) {
        Write-Host "[restart-tts] No process listening on port 8880."
        return
    }

    foreach ($targetPid in $targets) {
        try {
            Write-Host "[restart-tts] Stopping PID $targetPid (port 8880)..."
            Stop-Process -Id $targetPid -Force -ErrorAction Stop
        } catch {
            Write-Warning "[restart-tts] Could not stop PID ${targetPid}: $($_.Exception.Message)"
        }
    }

    Start-Sleep -Milliseconds 700
}

function Start-TtsServer {
    $envFile = Join-Path $PSScriptRoot ".env"
    Load-DotEnvFile -Path $envFile

    if (-not $env:TTS_BACKEND) { $env:TTS_BACKEND = "optimized" }
    if (-not $env:TTS_CONFIG) { $env:TTS_CONFIG = (Join-Path $PSScriptRoot "config.yaml") }
    if (-not $env:FORCED_VOICE_PROFILE) { $env:FORCED_VOICE_PROFILE = "Mario" }
    if (-not $env:VOICE_LIBRARY_DIR) { $env:VOICE_LIBRARY_DIR = (Join-Path $PSScriptRoot "voice_library") }
    if (-not $env:TTS_DEVICE) { $env:TTS_DEVICE = "auto" }
    if (-not $env:TTS_MAX_CONCURRENT) { $env:TTS_MAX_CONCURRENT = "1" }
    if (-not $env:HOST) { $env:HOST = "0.0.0.0" }
    if (-not $env:PORT) { $env:PORT = "8880" }

    Write-Host "[restart-tts] Starting TTS server with:"
    Write-Host "  TTS_BACKEND=$($env:TTS_BACKEND)"
    Write-Host "  TTS_CONFIG=$($env:TTS_CONFIG)"
    Write-Host "  FORCED_VOICE_PROFILE=$($env:FORCED_VOICE_PROFILE)"
    Write-Host "  VOICE_LIBRARY_DIR=$($env:VOICE_LIBRARY_DIR)"
    Write-Host "  PORT=$($env:PORT)"

    if ($Detached) {
        Start-Process -FilePath "python" -ArgumentList "-m api.main" -WorkingDirectory $PSScriptRoot | Out-Null
        Write-Host "[restart-tts] Started in detached mode."
    } else {
        Set-Location $PSScriptRoot
        python -m api.main
    }
}

Stop-TtsProcesses

if (-not $NoStart) {
    Start-TtsServer
} else {
    Write-Host "[restart-tts] NoStart enabled. Done."
}
