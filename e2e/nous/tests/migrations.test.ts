import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ensureSharedSupabase,
  releaseSharedSupabase,
  SUPABASE_IDLE_MS,
  sharedSupabaseStatus,
  stopIdleSupabase,
  watchIdleSupabase,
} from '../../../scripts/shared-supabase';

let root: string;
const status = {
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:test@127.0.0.1:54322/postgres',
  ANON_KEY: 'test',
  SERVICE_ROLE_KEY: 'test',
  JWT_SECRET: 'test',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nous-shared-stack-'));
  vi.stubEnv('NOUS_SHARED_SUPABASE_DATA', root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function runtime() {
  return {
    run: vi.fn(async (_args: string[]) => JSON.stringify(status)),
    health: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    container: vi.fn(async () => 'container-owned'),
  };
}
it('reuses healthy Supabase across proof data directories, preserving users and migrations', async () => {
  const options = runtime();
  vi.stubEnv('NOUS_E2E_DATA', join(root, 'proof-a'));
  expect(await ensureSharedSupabase(options)).toEqual(status);
  await releaseSharedSupabase();
  vi.stubEnv('NOUS_E2E_DATA', join(root, 'proof-b'));
  expect(await ensureSharedSupabase(options)).toEqual(status);
  expect(options.run.mock.calls.map(([args]) => args)).toEqual([
    ['status', '--output', 'json'],
    ['status', '--output', 'json'],
  ]);
  await releaseSharedSupabase();
  expect(await readdir(join(root, 'runs'))).toEqual([]);
  await expect(readFile(join(root, 'managed'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('starts an absent stack once and applies migrations without resetting it', async () => {
  const options = runtime();
  options.run.mockRejectedValueOnce(new Error('absent'));
  options.container.mockResolvedValueOnce('');
  await ensureSharedSupabase(options);
  expect(options.run.mock.calls.map(([args]) => args)).toEqual([
    ['status', '--output', 'json'],
    ['start'],
    ['status', '--output', 'json'],
    ['migration', 'up', '--local'],
  ]);
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
});
it('preserves an unhealthy existing stack, including a stopped database container', async () => {
  const options = runtime();
  options.run.mockRejectedValue(new Error('unhealthy'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('preserve the existing stack');
  expect(options.run).toHaveBeenCalledOnce();
  expect(options.watch).not.toHaveBeenCalled();
});
it.each(['migration', 'health'])('schedules idle cleanup after a failed %s', async failure => {
  const options = runtime();
  options.container.mockResolvedValueOnce('');
  options.run.mockRejectedValueOnce(new Error('absent'));
  if (failure === 'migration')
    options.run.mockImplementation(async args => {
      if (args[0] === 'migration') throw new Error('initialization failed');
      return JSON.stringify(status);
    });
  else options.health.mockRejectedValueOnce(new Error('initialization failed'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('initialization failed');
  expect(options.watch).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
  expect(await readdir(join(root, 'runs'))).toEqual([]);
  expect(Number(await readFile(join(root, 'last-run'), 'utf8'))).toBeGreaterThan(0);
  if (failure === 'migration')
    await expect(ensureSharedSupabase(options)).rejects.toThrow('initialization is incomplete');
});

it('rechecks at the release deadline instead of waiting a second full idle interval', async () => {
  let now = 0;
  await writeFile(join(root, 'managed'), 'container-owned');
  await writeFile(join(root, 'last-run'), '0');
  const releasedAt = SUPABASE_IDLE_MS / 2;
  const wait = vi.fn(async (milliseconds: number) => {
    now += milliseconds;
  });
  const check = vi.fn(async () => {
    if (check.mock.calls.length === 1) await writeFile(join(root, 'last-run'), String(releasedAt));
    else await rm(join(root, 'managed'));
  });
  await watchIdleSupabase({ wait, now: () => now, check });
  expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
    SUPABASE_IDLE_MS,
    releasedAt,
  ]);
  expect(now).toBe(releasedAt + SUPABASE_IDLE_MS);
});
it('adopts a healthy replacement after an incomplete initialization of another container', async () => {
  await writeFile(join(root, 'managed'), 'old-container');
  await writeFile(join(root, 'incomplete'), 'old-container');
  const options = runtime();
  expect(await ensureSharedSupabase(options)).toEqual(status);
  await expect(readFile(join(root, 'incomplete'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(options.run.mock.calls.map(([args]) => args)).toEqual([['status', '--output', 'json']]);
  await releaseSharedSupabase();
});
it('continues watching after Docker becomes temporarily unavailable', async () => {
  let now = 0;
  await writeFile(join(root, 'managed'), 'container-owned');
  await writeFile(join(root, 'last-run'), '0');
  const wait = async (milliseconds: number) => {
    now += milliseconds;
  };
  const check = vi.fn(async () => {
    if (check.mock.calls.length === 1) throw new Error('Docker unavailable');
    await rm(join(root, 'managed'));
  });
  await watchIdleSupabase({ wait, now: () => now, check });
  expect(check).toHaveBeenCalledTimes(2);
  expect(await readFile(join(root, 'idle-error.log'), 'utf8')).toContain('Docker unavailable');
});
it('rejects failed health checks before admitting a run', async () => {
  const options = runtime();
  options.health.mockRejectedValueOnce(new Error('auth unavailable'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('auth unavailable');
  expect(await readdir(join(root, 'runs'))).toEqual([]);
});
it('checks loopback identity before health requests or writes', async () => {
  const options = runtime();
  options.run.mockResolvedValue(
    JSON.stringify({ ...status, API_URL: 'https://remote.example:54321' })
  );
  await expect(sharedSupabaseStatus(options.run)).rejects.toThrow('local proof project');
});
it('stops only the managed container after 20 idle minutes and never while a proof is alive', async () => {
  const options = runtime();
  await ensureSharedSupabase(options);
  await writeFile(join(root, 'managed'), 'container-owned');
  const stamp = Number(await readFile(join(root, 'last-run'), 'utf8'));
  const stop = vi.fn(async () => {});
  const container = options.container;
  expect(await stopIdleSupabase({ now: stamp + SUPABASE_IDLE_MS, stop, container })).toBe(false);
  await releaseSharedSupabase();
  const released = Number(await readFile(join(root, 'last-run'), 'utf8'));
  expect(await stopIdleSupabase({ now: released + SUPABASE_IDLE_MS - 1, stop, container })).toBe(
    false
  );
  expect(await stopIdleSupabase({ now: released + SUPABASE_IDLE_MS, stop, container })).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
});
it('keeps an adopted or replaced stack running even when idle', async () => {
  const options = runtime();
  await ensureSharedSupabase(options);
  await releaseSharedSupabase();
  const stop = vi.fn(async () => {});
  const now = Date.now() + SUPABASE_IDLE_MS;
  expect(await stopIdleSupabase({ now, stop, container: options.container })).toBe(false);
  await writeFile(join(root, 'managed'), 'other-container');
  expect(await stopIdleSupabase({ now, stop, container: options.container })).toBe(false);
  expect(stop).not.toHaveBeenCalled();
});
