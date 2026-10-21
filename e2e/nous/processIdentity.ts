import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as z from 'zod';

const execute = promisify(execFile);

/** Birth time and command distinguish an owned process from a recycled PID. */
export async function processIdentity(
  pid: number,
  {
    platform = process.platform,
    includeCommand = true,
  }: { platform?: NodeJS.Platform; includeCommand?: boolean } = {}
): Promise<string | undefined> {
  if (platform === 'win32') {
    const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ startedAt = $p.CreationDate.ToUniversalTime().ToString('o'); command = $p.CommandLine } | ConvertTo-Json -Compress }`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
    });
    if (!stdout.trim()) return undefined;
    const identity = z
      .object({ startedAt: z.string().min(1), command: z.string().nullable() })
      .parse(JSON.parse(stdout));
    return includeCommand ? JSON.stringify(identity) : identity.startedAt;
  }
  try {
    const { stdout } = await execute(
      'ps',
      ['-ww', '-p', String(pid), '-o', 'lstart=', ...(includeCommand ? ['-o', 'args='] : [])],
      { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }
    );
    return stdout.trim() || undefined;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw error;
  }
}
