# Capture the process tree and CPU use of one gate run without recording command lines.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string[]]$Command = @('bun.exe', 'run', 'gate:full'),
  [int]$SampleIntervalSeconds = 1
)
$ErrorActionPreference = 'Stop'
if ($Command.Length -lt 2) { throw 'Command must include an executable and arguments.' }
if ($SampleIntervalSeconds -le 0) { throw 'The sampling interval must be positive.' }
$repository = (Get-Location).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$stdoutPath = Join-Path $output 'stdout.log'
$stderrPath = Join-Path $output 'stderr.log'
$samplesPath = Join-Path $output 'processes.jsonl'
$runPath = Join-Path $output 'run.json'
if (Test-Path -LiteralPath $runPath) { Remove-Item -LiteralPath $runPath }
$processors = @(Get-CimInstance Win32_Processor)
$logicalProcessors = ($processors | Measure-Object NumberOfLogicalProcessors -Sum).Sum
$physicalCores = ($processors | Measure-Object NumberOfCores -Sum).Sum
function Get-SonarRunning {
  $state = docker inspect lumina-sonarqube --format '{{.State.Running}}' 2>$null
  if ($LASTEXITCODE -eq 0) { return $state -eq 'true' }
  return $null
}
$sonarRunningBefore = Get-SonarRunning
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command $Command[0]).Source
$startInfo.WorkingDirectory = $repository
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in $Command[1..($Command.Length - 1)]) {
  $startInfo.ArgumentList.Add($argument)
}
$stdoutFile = [IO.FileStream]::new($stdoutPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1, $true)
$stderrFile = [IO.FileStream]::new($stderrPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite, 1, $true)
$gate = [Diagnostics.Process]::new()
$gate.StartInfo = $startInfo
$started = $false
$stdoutCopy = $null
$stderrCopy = $null
$writer = $null
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  [void]$gate.Start()
  $started = $true
  $stdoutCopy = $gate.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
  $stderrCopy = $gate.StandardError.BaseStream.CopyToAsync($stderrFile)
  $gateStartedAt = $gate.StartTime
  $null = $gate.Handle
  $owned = [Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($gate.Id)
  $births = [Collections.Generic.Dictionary[int,datetime]]::new()
  $writer = [IO.StreamWriter]::new($samplesPath, $false)
  do {
    $processes = @(Get-CimInstance Win32_Process)
    $liveBirths = [Collections.Generic.Dictionary[int,datetime]]::new()
    foreach ($process in $processes) {
      $id = [int]$process.ProcessId
      $liveBirths[$id] = $process.CreationDate
      if ($owned.Contains($id)) {
        if ($births.ContainsKey($id) -and $births[$id] -ne $process.CreationDate) {
          [void]$owned.Remove($id)
        } else { $births[$id] = $process.CreationDate }
      }
    }
    if (-not $births.ContainsKey($gate.Id)) { $births[$gate.Id] = $gateStartedAt }
    # Retain observed descendants, but adopt children only from a verified live parent.
    do {
      $added = $false
      foreach ($process in $processes) {
        if (
          $process.CreationDate -ge $gateStartedAt -and
          $owned.Contains([int]$process.ParentProcessId) -and
          $liveBirths.ContainsKey([int]$process.ParentProcessId) -and
          $liveBirths[[int]$process.ParentProcessId] -eq $births[[int]$process.ParentProcessId] -and
          $process.CreationDate -ge $births[[int]$process.ParentProcessId] -and
          $owned.Add([int]$process.ProcessId)
        ) {
          $births[[int]$process.ProcessId] = $process.CreationDate
          $added = $true
        }
      }
    } while ($added)
    $stage = @(Select-String -LiteralPath $stdoutPath -Pattern '^=== Starting ' | Select-Object -Last 1).Line
    $observed = foreach ($process in $processes) {
      $processCommandLine = [string]$process.CommandLine
      $isOwned = $owned.Contains([int]$process.ProcessId)
      $kind = switch -Regex ($processCommandLine) {
        'mermaidValidationProcess\.mjs' { 'mermaid'; break }
        'chrom(e|ium)|headless_shell' { 'browser'; break }
        '[/\\]workers[/\\](forks|threads)\.js' { 'vitest-worker'; break }
        'vitest' { 'vitest-runner'; break }
        'sonar|scanner' { 'sonar'; break }
        default { if ($isOwned) { 'gate-child' } else { 'other' } }
      }
      if ($isOwned -or $kind -ne 'other' -or $process.Name -match 'vmmem') {
        [ordered]@{
          id = [int]$process.ProcessId
          parentId = [int]$process.ParentProcessId
          createdUtc = $process.CreationDate.ToUniversalTime().ToString('o')
          name = $process.Name
          kind = $kind
          owned = $isOwned
          cpuSeconds = ([double]$process.KernelModeTime + [double]$process.UserModeTime) / [TimeSpan]::TicksPerSecond
          threads = [int]$process.ThreadCount
          workingSetBytes = [double]$process.WorkingSetSize
        }
      }
    }
    $sample = [ordered]@{
      elapsedSeconds = $timer.Elapsed.TotalSeconds
      utc = [DateTime]::UtcNow.ToString('o')
      stage = $stage
      logicalProcessors = $logicalProcessors
      processes = @($observed)
    }
    $writer.WriteLine(($sample | ConvertTo-Json -Compress -Depth 5))
    $writer.Flush()
    Start-Sleep -Seconds $SampleIntervalSeconds
    $gate.Refresh()
  } while (-not $gate.HasExited)
  $gate.WaitForExit()
  $exitCode = $gate.ExitCode
} finally {
  if ($started -and -not $gate.HasExited) {
    $gate.Kill($true)
    $gate.WaitForExit()
  }
  if ($null -ne $writer) { $writer.Dispose() }
  try {
    if ($null -ne $stdoutCopy) { $null = $stdoutCopy.GetAwaiter().GetResult() }
    if ($null -ne $stderrCopy) { $null = $stderrCopy.GetAwaiter().GetResult() }
  } finally {
    $stdoutFile.Dispose()
    $stderrFile.Dispose()
    $gate.Dispose()
    $timer.Stop()
  }
}
$summary = [ordered]@{
  executable = $Command[0]
  physicalCores = $physicalCores
  sonarRunningBefore = $sonarRunningBefore
  sonarRunningAfter = Get-SonarRunning
  commit = (git rev-parse HEAD)
  exitCode = $exitCode
  durationSeconds = $timer.Elapsed.TotalSeconds
  logicalProcessors = $logicalProcessors
}
$summary | ConvertTo-Json | Set-Content -LiteralPath $runPath
$summary | ConvertTo-Json
exit $exitCode
