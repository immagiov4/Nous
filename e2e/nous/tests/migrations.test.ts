import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ProofMigration, reconcileProofMigrations } from '../../../scripts/proof-migrations';
import {
  ensureSharedSupabase,
  releaseSharedSupabase,
  SUPABASE_IDLE_MS,
  sharedSupabaseStatus,
  stopIdleSupabase,
  watchIdleSupabase,
} from '../../../scripts/shared-supabase';
import { processIdentity } from '../processIdentity';

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
    reconcile: vi.fn(async () => true),
    snapshot: vi.fn(async () => ({
      revision: 'main',
      main: [] as ProofMigration[],
      local: [] as ProofMigration[],
    })),
    isolate: vi.fn(async () => ({
      ...status,
      API_URL: 'http://127.0.0.1:60001',
      DB_URL: 'postgresql://postgres:test@127.0.0.1:60002/postgres',
    })),
  };
}
it('checks migration parity under the admission lock and isolates a divergent checkout', async () => {
  const options = runtime();
  options.reconcile.mockResolvedValue(false);
  expect((await ensureSharedSupabase(options)).API_URL).toBe('http://127.0.0.1:60001');
  expect(options.isolate).toHaveBeenCalledOnce();
  expect(options.reconcile).toHaveBeenCalledOnce();
  expect(await readdir(join(root, 'runs'))).toEqual([]);
});
it('isolates branch-only SQL before inspecting or starting the shared stack', async () => {
  const options = runtime();
  options.snapshot.mockResolvedValue({
    revision: 'main',
    main: [],
    local: [
      {
        version: '2',
        name: 'branch',
        sql: 'create table branch_only (id int);',
        hash: 'branch-hash',
      },
    ],
  });
  expect((await ensureSharedSupabase(options)).API_URL).toBe('http://127.0.0.1:60001');
  expect(options.run).not.toHaveBeenCalled();
  expect(options.reconcile).not.toHaveBeenCalled();
  expect(options.isolate).toHaveBeenCalledOnce();
});
it('keeps the lifecycle reservation through dedicated startup without borrowing shared watcher ownership', async () => {
  const options = runtime();
  await writeFile(join(root, 'managed'), 'container-owned');
  options.reconcile.mockResolvedValue(false);
  let started!: () => void;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  let finish!: (value: typeof status) => void;
  options.isolate.mockImplementation(async () => {
    started();
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  options.watch.mockRejectedValue(new Error('watcher unavailable'));
  const admission = ensureSharedSupabase(options);
  await entered;
  const watchedBeforeCompletion = options.watch.mock.calls.length;
  finish(status);
  expect(await admission).toEqual(status);
  expect(watchedBeforeCompletion).toBe(0);
  expect(options.watch).not.toHaveBeenCalled();
});
it('serializes two proofs through migration reconciliation and applies each version once', async () => {
  const options = runtime();
  const main = [
    { version: '2', name: 'main', sql: 'create table main_only (id int);', hash: 'main-hash' },
  ];
  const snapshot = { revision: 'main', main, local: main };
  options.snapshot.mockResolvedValue(snapshot);
  const applied: string[] = [];
  let active = 0;
  const apply = vi.fn(async (migration: ProofMigration) => {
    active++;
    expect(active).toBe(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    applied.push(migration.version);
    active--;
  });
  options.reconcile.mockImplementation(() =>
    reconcileProofMigrations(snapshot, {
      applied: async () => [...applied],
      apply,
      close: async () => {},
    })
  );
  expect(await Promise.all([ensureSharedSupabase(options), ensureSharedSupabase(options)])).toEqual(
    [status, status]
  );
  expect(apply).toHaveBeenCalledOnce();
  expect(applied).toEqual(['2']);
  await releaseSharedSupabase();
});
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
  ]);
  expect(options.reconcile).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
});
it('inspects retained migration history before applying SQL after a container restart', async () => {
  const options = runtime();
  options.run.mockImplementation(async args => {
    if (args[0] === 'migration') throw new Error('SQL ran before the history comparison');
    return JSON.stringify(status);
  });
  options.run.mockRejectedValueOnce(new Error('container absent, volume retained'));
  options.container.mockResolvedValueOnce('');
  options.reconcile.mockResolvedValue(false);
  expect((await ensureSharedSupabase(options)).API_URL).toBe('http://127.0.0.1:60001');
  expect(options.isolate).toHaveBeenCalledOnce();
});
it('preserves an unhealthy existing stack, including a stopped database container', async () => {
  const options = runtime();
  options.run.mockRejectedValue(new Error('unhealthy'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('preserve the existing stack');
  expect(options.run).toHaveBeenCalledOnce();
  expect(options.watch).not.toHaveBeenCalled();
});
it('owns a newly started stack after the previous managed container was removed', async () => {
  await writeFile(join(root, 'managed'), 'removed-container');
  await writeFile(join(root, 'incomplete'), 'removed-container');
  const options = runtime();
  options.run.mockRejectedValueOnce(new Error('absent'));
  options.container.mockResolvedValueOnce('');
  await ensureSharedSupabase(options);
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
  await releaseSharedSupabase();
  const stop = vi.fn(async () => {});
  expect(
    await stopIdleSupabase({
      now: Date.now() + SUPABASE_IDLE_MS,
      stop,
      container: options.container,
    })
  ).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
});
it('serializes simultaneous admissions so an absent stack starts only once', async () => {
  let started = false;
  const options = runtime();
  options.run.mockImplementation(async args => {
    if (args[0] === 'status' && !started) throw new Error('absent');
    if (args[0] === 'start') started = true;
    return JSON.stringify(status);
  });
  options.container.mockImplementation(async () => (started ? 'container-owned' : ''));
  const admitted = await Promise.all([
    ensureSharedSupabase(options),
    ensureSharedSupabase(options),
  ]);
  expect(admitted).toEqual([status, status]);
  expect(options.run.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1);
  await releaseSharedSupabase();
  expect(await readdir(join(root, 'runs'))).toEqual([]);
});
it.each([
  'exited-owner',
  'empty-reservation',
])('recovers a lifecycle reservation left by %s', async kind => {
  const reservation = join(root, 'lifecycle.lock');
  await mkdir(reservation);
  if (kind === 'exited-owner') {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'exit');
    await writeFile(
      join(reservation, 'exited-owner'),
      JSON.stringify({ pid: child.pid, identity: 'exited-process-identity' })
    );
  }
  const options = runtime();
  expect(await ensureSharedSupabase(options)).toEqual(status);
  await releaseSharedSupabase();
  await expect(readdir(reservation)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('cancels a waiting admission without removing the live reservation', async () => {
  const reservation = join(root, 'lifecycle.lock');
  await mkdir(reservation);
  const identity = await processIdentity(process.pid, { includeCommand: false });
  await writeFile(join(reservation, 'live-owner'), JSON.stringify({ pid: process.pid, identity }));
  const options = runtime();
  await expect(
    ensureSharedSupabase({ ...options, signal: AbortSignal.abort(new Error('cancelled')) })
  ).rejects.toThrow('cancelled');
  expect(options.run).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(reservation, 'live-owner'), 'utf8'))).toEqual({
    pid: process.pid,
    identity,
  });
  expect((await readdir(root)).filter(name => name.startsWith('lifecycle-'))).toEqual([]);
});
it('reclaims a lifecycle reservation whose PID has been recycled', async () => {
  const reservation = join(root, 'lifecycle.lock');
  await mkdir(reservation);
  await writeFile(
    join(reservation, 'previous-owner'),
    JSON.stringify({ pid: process.pid, identity: 'previous-process-identity' })
  );
  const options = runtime();
  expect(await ensureSharedSupabase(options)).toEqual(status);
  await releaseSharedSupabase();
});
it('does not retain an idle stack for a recycled proof PID', async () => {
  const options = runtime();
  await ensureSharedSupabase(options);
  await releaseSharedSupabase();
  await writeFile(join(root, 'managed'), 'container-owned');
  await writeFile(
    join(root, 'runs', 'previous-proof'),
    JSON.stringify({ pid: process.pid, identity: 'previous-process-identity' })
  );
  const stop = vi.fn(async () => {});
  expect(
    await stopIdleSupabase({
      now: Date.now() + SUPABASE_IDLE_MS,
      stop,
      container: options.container,
    })
  ).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
});
it.each(['migration', 'health'])('schedules idle cleanup after a failed %s', async failure => {
  const options = runtime();
  options.container.mockResolvedValueOnce('');
  options.run.mockRejectedValueOnce(new Error('absent'));
  if (failure === 'migration')
    options.reconcile.mockRejectedValueOnce(new Error('initialization failed'));
  else options.health.mockRejectedValueOnce(new Error('initialization failed'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('initialization failed');
  expect(options.watch).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
  expect(await readdir(join(root, 'runs'))).toEqual([]);
  expect(Number(await readFile(join(root, 'last-run'), 'utf8'))).toBeGreaterThan(0);
  if (failure === 'migration') expect(await ensureSharedSupabase(options)).toEqual(status);
});
it('retains startup ownership when Docker inspection fails after start', async () => {
  const options = runtime();
  options.run.mockRejectedValueOnce(new Error('absent'));
  options.container
    .mockResolvedValueOnce('')
    .mockRejectedValueOnce(new Error('Docker inspection unavailable'));
  await expect(ensureSharedSupabase(options)).rejects.toThrow('Docker inspection unavailable');
  expect(await readFile(join(root, 'starting'), 'utf8')).toBe('nous-reader');
  expect(options.watch).toHaveBeenCalledOnce();
  await expect(ensureSharedSupabase(options)).rejects.toThrow('initialization is incomplete');
  expect(await readFile(join(root, 'managed'), 'utf8')).toBe('container-owned');
  const stop = vi.fn(async () => {});
  expect(
    await stopIdleSupabase({
      now: Date.now() + SUPABASE_IDLE_MS,
      stop,
      container: options.container,
    })
  ).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
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
it('retains incomplete initialization while temporarily adopting the other project', async () => {
  await writeFile(join(root, 'managed'), 'container-owned');
  await writeFile(join(root, 'incomplete'), 'container-owned');
  const options = runtime();
  options.run.mockResolvedValueOnce(
    JSON.stringify({
      ...status,
      API_URL: 'http://127.0.0.1:55321',
      DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
    })
  );
  await ensureSharedSupabase(options);
  await releaseSharedSupabase();
  expect(await readFile(join(root, 'incomplete'), 'utf8')).toBe('container-owned');
  await expect(ensureSharedSupabase(options)).rejects.toThrow('initialization is incomplete');
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
