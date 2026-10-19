import { closeSync, fstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../stack';

let root: string | undefined;
const children: Bun.Subprocess[] = [];
const descriptors: number[] = [];

afterEach(async () => {
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
  const previousExecFileBudgetBytes = 1024 * 1024;
  vi.spyOn(Bun, 'spawn').mockImplementation((command, options) => {
    const identityCommand = Array.isArray(command) && ['powershell.exe', 'ps'].includes(command[0]);
    const actualCommand = identityCommand
      ? [
          process.execPath,
          '-e',
          `console.log(JSON.stringify({startedAt:'synthetic', command:'x'.repeat(${previousExecFileBudgetBytes + 1})}))`,
        ]
      : command;
    const child = originalSpawn(actualCommand, options);
    children.push(child);
    return child;
  });
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
