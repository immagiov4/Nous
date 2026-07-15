import {
  getBackendServerConfig,
  loadServerConfig,
} from '../apps/backend/src/config/serverConfig.ts';

const { backendPort } = getBackendServerConfig(loadServerConfig());

const command =
  process.platform === 'win32'
    ? [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `$connections = Get-NetTCPConnection -State Listen -LocalPort ${backendPort} -ErrorAction SilentlyContinue; if ($connections) { $connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction Stop } }; exit 0`,
      ]
    : [
        'sh',
        '-c',
        `command -v lsof >/dev/null && kill $(lsof -ti tcp:${backendPort}) 2>/dev/null || true`,
      ];

const result = Bun.spawnSync(command, { stderr: 'inherit', stdout: 'inherit' });
if (!result.success) {
  throw new Error(`Unable to free backend port ${backendPort}.`);
}

console.log(`[Dev] Backend port ${backendPort} is ready.`);
