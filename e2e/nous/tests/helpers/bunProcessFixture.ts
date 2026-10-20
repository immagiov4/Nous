import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { vi } from 'vitest';

/** Node coverage exercises stack lifecycle code with real child processes; Bun tests use its native API. */
export const installBunProcessFixture = (): void => {
  if (typeof Bun !== 'undefined') return;
  vi.stubGlobal('Bun', {
    spawn: (
      command: string[],
      options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        detached?: boolean;
        windowsHide?: boolean;
        stdout?: 'pipe' | 'ignore' | number;
        stderr?: 'pipe' | 'ignore' | number;
      } = {}
    ) => {
      const child = spawn(command[0], command.slice(1), {
        ...options,
        windowsHide: true,
        stdio: ['ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
      });
      const exited = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 0));
      });
      return {
        pid: child.pid,
        stdout: child.stdout ? Readable.toWeb(child.stdout) : undefined,
        stderr: child.stderr ? Readable.toWeb(child.stderr) : undefined,
        exited,
        unref: () => child.unref(),
        kill: (signal?: NodeJS.Signals) => child.kill(signal),
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
      };
    },
  });
};
