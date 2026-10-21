import { closeSync, fstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const identityFixture = vi.hoisted(() => ({ command: undefined as string[] | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = promisify(original.execFile);
  return {
    ...original,
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: (
        executable: string,
        args: string[],
        options: Parameters<typeof execute>[2]
      ) => {
        const command =
          identityFixture.command && ['powershell.exe', 'ps'].includes(executable)
            ? identityFixture.command
            : [executable, ...args];
        return execute(command[0], command.slice(1), options);
      },
    }),
  };
});

import { startServer } from '../stack';
import { installBunProcessFixture } from './helpers/bunProcessFixture';

beforeEach(installBunProcessFixture);

let root: string | undefined;
const children: Bun.Subprocess[] = [];
const descriptors: number[] = [];

afterEach(async () => {
  identityFixture.command = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const descriptor of descriptors.splice(0)) {
    try {
      closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'nous-hidden-command-'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  await mkdir(join(root, 'stack'));
}

it('closes the process log when native process creation fails', async () => {
  await fixture();
  let descriptor: number | undefined;
  vi.spyOn(Bun, 'spawn').mockImplementationOnce((_command, options) => {
    descriptor = options?.stdout as number;
    descriptors.push(descriptor);
    throw new Error('Synthetic native process creation failure');
  });
  await expect(startServer('fixture', [], 'http://synthetic.test', process.env)).rejects.toThrow(
    'Synthetic native process creation failure'
  );
  expect(descriptor).toBeTypeOf('number');
  expect(() => fstatSync(descriptor as number)).toThrow(expect.objectContaining({ code: 'EBADF' }));
});

it('retains the execFile output budget when reading process identity', async () => {
  await fixture();
  const originalSpawn = Bun.spawn.bind(Bun);
  vi.spyOn(Bun, 'spawn').mockImplementation((command, options) => {
    const child = originalSpawn(command, options);
    children.push(child);
    return child;
  });
  const previousExecFileBudgetBytes = 1024 * 1024;
  identityFixture.command = [
    process.execPath,
    '-e',
    `console.log(JSON.stringify({startedAt:'synthetic', command:'x'.repeat(${previousExecFileBudgetBytes + 1})}))`,
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('healthy'))
  );
  await expect(
    startServer(
      'fixture',
      ['-e', 'setInterval(() => {}, 1000)'],
      'http://synthetic.test',
      process.env
    )
  ).rejects.toThrow('stdout maxBuffer length exceeded');
});
