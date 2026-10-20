import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: host.execute });
  return { ...original, execFile, spawn: host.spawn };
});

import {
  ensureSharedSupabase,
  main,
  releaseSharedSupabase,
  SUPABASE_IDLE_MS,
  sharedSupabaseStatus,
  watchIdleSupabase,
} from '../../../scripts/shared-supabase';

let root: string;
let containers: { name: string; id: string; running: boolean }[];
const originalExitCode = process.exitCode;
const reader = 'supabase_db_nous-reader';
const playtest = 'supabase_db_nous-playtest';
const status = {
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:test@127.0.0.1:54322/postgres',
  ANON_KEY: 'test-anon',
  SERVICE_ROLE_KEY: 'test-service',
  JWT_SECRET: 'test-secret',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nous-shared-command-'));
  vi.stubEnv('NOUS_SHARED_SUPABASE_DATA', root);
  containers = [{ name: reader, id: 'reader-id', running: true }];
  host.execute.mockReset();
  host.spawn.mockReset();
  host.execute.mockImplementation(async (binary: string, args: string[]) => {
    if (binary === 'docker') {
      const filter = args[args.indexOf('--filter') + 1];
      const matching = containers.filter(
        container =>
          (args.includes('-a') || container.running) &&
          (!args.includes('--filter') ||
            new RegExp(filter.slice('name='.length)).test(`/${container.name}`))
      );
      return {
        stdout: matching
          .map(container => (args.includes('{{.Names}}') ? container.name : container.id))
          .join('\n'),
      };
    }
    if (args[0] === 'status') {
      const legacy = args.at(-1)?.endsWith('nous-playtest');
      if (
        !containers.some(
          container => container.name === (legacy ? playtest : reader) && container.running
        )
      )
        throw new Error('Container absent');
      return {
        stdout: JSON.stringify(
          legacy
            ? {
                ...status,
                API_URL: 'http://127.0.0.1:55321',
                DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
              }
            : status
        ),
      };
    }
    if (args[0] === 'start') containers.push({ name: reader, id: 'reader-id', running: true });
    return { stdout: '' };
  });
  host.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 }))
  );
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function mockBunSpawn(spawn: unknown): void {
  if (typeof Bun === 'undefined') vi.stubGlobal('Bun', { spawn });
  else vi.spyOn(Bun, 'spawn').mockImplementation(spawn as typeof Bun.spawn);
}

it('adopts the running playtest when a stopped reader container also exists', async () => {
  containers = [
    { name: reader, id: 'stopped-reader', running: false },
    { name: playtest, id: 'playtest-id', running: true },
  ];
  expect((await sharedSupabaseStatus()).API_URL).toBe('http://127.0.0.1:55321');
  const config = parse(await readFile(join(root, 'nous-playtest/supabase/config.toml'), 'utf8'));
  expect(config).toMatchObject({
    project_id: 'nous-playtest',
    api: { port: 55321 },
    db: { port: 55322 },
  });
});

it('checks authenticated service health before admitting a proof', async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(null, { status: url.endsWith('/storage/v1/status') ? 503 : 200 })
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(ensureSharedSupabase()).rejects.toThrow('HTTP 503');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${status.API_URL}/auth/v1/health`,
    `${status.API_URL}/rest/v1/`,
    `${status.API_URL}/storage/v1/status`,
  ]);
  expect(await readdir(join(root, 'runs'))).toEqual([]);
});

it('starts one hidden idle watcher and reuses it for later admissions', async () => {
  containers = [];
  await ensureSharedSupabase();
  await ensureSharedSupabase();
  expect(host.spawn).toHaveBeenCalledOnce();
  expect(host.spawn.mock.calls[0][2]).toMatchObject({
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('reader-id');
  await releaseSharedSupabase();
});

it('keeps service credentials out of command errors while retaining private diagnostics', async () => {
  host.execute.mockImplementation(async (binary: string) => {
    if (binary === 'docker') return { stdout: reader };
    throw Object.assign(new Error('CLI failed'), {
      stdout: 'credential-from-status',
      stderr: 'Container unavailable',
    });
  });
  await expect(sharedSupabaseStatus()).rejects.toThrow('supabase-error.log');
  try {
    await sharedSupabaseStatus();
  } catch (error) {
    expect(String(error)).not.toContain('credential-from-status');
    expect(error).not.toHaveProperty('stdout');
  }
  expect(await readFile(join(root, 'supabase-error.log'), 'utf8')).toBe('Container unavailable');
});

it.each([
  ['--', 'proof-command', 'argument'],
  ['proof-command', 'argument'],
])('forwards authenticated configuration and the proof exit code for %j', async (...args) => {
  const spawn = vi.fn(() => ({ exited: Promise.resolve(17) }));
  mockBunSpawn(spawn);
  await main(args);
  expect(process.exitCode).toBe(17);
  expect(spawn.mock.calls[0]).toEqual([
    ['proof-command', 'argument'],
    expect.objectContaining({
      windowsHide: true,
      env: expect.objectContaining({
        DATABASE_URL: status.DB_URL,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        SUPABASE_JWT_ISSUER: `${status.API_URL}/auth/v1`,
        AUTH_MODE: 'supabase',
        LOCAL_AUTH_BYPASS: 'false',
      }),
    }),
  ]);
  expect(await readdir(join(root, 'runs'))).toEqual([]);
});

it('queues an idle check independently of the proof that launched the watcher', async () => {
  await writeFile(join(root, 'managed'), 'reader-id');
  await writeFile(join(root, 'last-run'), '0');
  vi.stubEnv('HEAVY_RUN_HELD', '1');
  const spawn = vi.fn(() => ({ exited: rm(join(root, 'managed')).then(() => 0) }));
  mockBunSpawn(spawn);
  await watchIdleSupabase({ now: () => SUPABASE_IDLE_MS, wait: async () => {} });
  expect(spawn.mock.calls[0]).toEqual([
    expect.arrayContaining(['--label', 'supabase idle stop', '--idle-stop']),
    expect.objectContaining({
      windowsHide: true,
      env: expect.objectContaining({ HEAVY_RUN_HELD: '' }),
    }),
  ]);
});

it('handles idle CLI modes and rejects missing proof commands', async () => {
  await ensureSharedSupabase();
  await releaseSharedSupabase();
  await writeFile(join(root, 'managed'), 'reader-id');
  await writeFile(join(root, 'last-run'), '0');
  await main(['--idle-stop']);
  await expect(readFile(join(root, 'managed'))).rejects.toMatchObject({ code: 'ENOENT' });
  await main(['--watch-idle']);
  await expect(main([])).rejects.toThrow('Usage:');
});
