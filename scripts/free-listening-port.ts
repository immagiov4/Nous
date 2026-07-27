const buildFreePortCommand = (port: number): string[] =>
  process.platform === 'win32'
    ? [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `$connections = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; if ($connections) { $processes = Get-CimInstance Win32_Process; $connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $current = $processes | Where-Object ProcessId -eq $_; $bunRoot = $null; while ($current -and $current.Name -ieq 'bun.exe') { $bunRoot = $current; $current = $processes | Where-Object ProcessId -eq $current.ParentProcessId }; if ($bunRoot) { taskkill.exe /PID $bunRoot.ProcessId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw "Unable to stop process tree $($bunRoot.ProcessId)." } } else { Stop-Process -Id $_ -Force -ErrorAction Stop } } }; exit 0`,
      ]
    : [
        'sh',
        '-c',
        `command -v lsof >/dev/null && kill $(lsof -ti tcp:${port}) 2>/dev/null || true`,
      ];

export const freeListeningPort = (port: number): void => {
  const result = Bun.spawnSync(buildFreePortCommand(port), {
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (!result.success) {
    throw new Error(`Unable to free port ${port}.`);
  }

  console.log(`[Dev] Port ${port} is ready.`);
};
