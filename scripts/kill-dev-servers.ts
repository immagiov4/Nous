// Stops local dev servers on the standard Lumina Reader ports.
const DEV_PORTS = [5173, 3301] as const;
const writeStatus = (message: string) => {
  process.stdout.write(`${message}\n`);
};

const isWindows = process.platform === 'win32';

const runCommand = async (command: string[]) => {
  const process = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { exitCode, stderr, stdout };
};

const parseWindowsProcessIds = (stdout: string) =>
  stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => Number.parseInt(line, 10))
    .filter(Number.isInteger);

const parseUnixProcessIds = (stdout: string) =>
  stdout
    .split(/\s+/)
    .map(value => Number.parseInt(value, 10))
    .filter(Number.isInteger);

const findWindowsPortProcessIds = async (port: number) => {
  const { stdout } = await runCommand([
    'powershell',
    '-NoProfile',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
  ]);
  return parseWindowsProcessIds(stdout);
};

const findUnixPortProcessIds = async (port: number) => {
  const { stdout } = await runCommand(['sh', '-lc', `lsof -ti tcp:${port} -sTCP:LISTEN || true`]);
  return parseUnixProcessIds(stdout);
};

const findPortProcessIds = (port: number) =>
  isWindows ? findWindowsPortProcessIds(port) : findUnixPortProcessIds(port);

const killProcess = async (pid: number) => {
  if (pid === process.pid) {
    return;
  }

  if (isWindows) {
    await runCommand(['taskkill', '/PID', String(pid), '/T', '/F']);
    return;
  }

  await runCommand(['kill', '-TERM', String(pid)]);
};

const uniqueProcessIds = (processIds: number[]) => [...new Set(processIds)];

for (const port of DEV_PORTS) {
  const processIds = uniqueProcessIds(await findPortProcessIds(port));
  if (processIds.length === 0) {
    continue;
  }

  writeStatus(`[dev] Closing old server on port ${port}: ${processIds.join(', ')}`);
  await Promise.all(processIds.map(killProcess));
}
