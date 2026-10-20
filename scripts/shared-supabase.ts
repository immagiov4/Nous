import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as z from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUPABASE_IDLE_MS = 20 * 60_000;
export const STACK_READINESS_POLL_INTERVAL_MS = 500;
const PROJECT = 'nous-reader';
const LEGACY_PROJECT = 'nous-playtest';
const STACK_PORTS = [
  { api: 54321, db: 54322 },
  { api: 55321, db: 55322 },
];
const execute = promisify(execFile);
const statusSchema = z.object({
  API_URL: z.url(),
  DB_URL: z.url(),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
});
export type SharedSupabaseStatus = z.infer<typeof statusSchema>;
const lease = `${process.pid}-${crypto.randomUUID()}`;
const stateRoot = () =>
  process.env.NOUS_SHARED_SUPABASE_DATA || join(homedir(), '.cache', 'nous-supabase');

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function removeReservation(directory: string, owner?: string): Promise<void> {
  if (owner) await rm(join(directory, owner), { force: true });
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
  });
}

async function retireStaleReservation(reservation: string): Promise<void> {
  const owners = await readdir(reservation).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const previous = owners[0];
  if (!previous) {
    await removeReservation(reservation);
    return;
  }
  const pid = await readOptional(join(reservation, previous));
  if (pid && !alive(Number(pid))) await removeReservation(reservation, previous);
}

/** Publish a complete owner record atomically; stale cleanup removes only that owner's file. */
async function withSharedLifecycle<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const root = stateRoot();
  const owner = crypto.randomUUID();
  const prepared = join(root, `lifecycle-${owner}`);
  const reservation = join(root, 'lifecycle.lock');
  await mkdir(prepared, { recursive: true });
  let acquired = false;
  try {
    await writeFile(join(prepared, owner), String(process.pid));
    while (!acquired) {
      signal?.throwIfAborted();
      try {
        await rename(prepared, reservation);
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !['EEXIST', 'ENOTEMPTY'].includes(code ?? '') &&
          !(code === 'EPERM' && existsSync(reservation))
        )
          throw error;
        await retireStaleReservation(reservation);
        await delay(STACK_READINESS_POLL_INTERVAL_MS, undefined, { signal });
      }
    }
    return await work();
  } finally {
    await removeReservation(acquired ? reservation : prepared, owner);
  }
}

async function command(args: string[], signal?: AbortSignal): Promise<string> {
  const binary = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'supabase.exe' : 'supabase'
  );
  let workdir = ROOT;
  const { stdout: containers } = await execute('docker', ['ps', '--format', '{{.Names}}'], {
    windowsHide: true,
    signal,
  });
  const names = containers.trim().split(/\r?\n/);
  if (
    !names.includes(`supabase_db_${PROJECT}`) &&
    names.includes(`supabase_db_${LEGACY_PROJECT}`)
  ) {
    workdir = join(stateRoot(), LEGACY_PROJECT);
    await mkdir(join(workdir, 'supabase'), { recursive: true });
    await writeFile(
      join(workdir, 'supabase/config.toml'),
      `project_id = "${LEGACY_PROJECT}"\n[api]\nport = ${STACK_PORTS[1].api}\n[db]\nport = ${STACK_PORTS[1].db}\n`
    );
  }
  try {
    const { stdout } = await execute(binary, [...args, '--workdir', workdir], {
      windowsHide: true,
      signal,
    });
    return stdout;
  } catch (error) {
    // CLI status output contains service keys; retain stderr privately, never attach stdout to errors.
    await mkdir(stateRoot(), { recursive: true });
    await writeFile(
      join(stateRoot(), 'supabase-error.log'),
      String((error as { stderr?: string }).stderr ?? '')
    );
    throw new Error(
      `Shared Supabase ${args[0]} failed. See ${join(stateRoot(), 'supabase-error.log')}.`
    );
  }
}

export async function sharedSupabaseStatus(
  run = command,
  signal?: AbortSignal
): Promise<SharedSupabaseStatus> {
  const status = statusSchema.parse(JSON.parse(await run(['status', '--output', 'json'], signal)));
  assertLocalProofStatus(status);
  return status;
}

export function assertLocalProofStatus(status: SharedSupabaseStatus): void {
  const api = new URL(status.API_URL);
  const db = new URL(status.DB_URL);
  if (
    ![api, db].every(url => ['localhost', '127.0.0.1'].includes(url.hostname)) ||
    !STACK_PORTS.some(ports => Number(api.port) === ports.api && Number(db.port) === ports.db)
  )
    throw new Error('Supabase status does not match a local proof project.');
}

export function sharedSupabaseEnvironment(status: SharedSupabaseStatus): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: status.DB_URL,
    SUPABASE_URL: status.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: status.JWT_SECRET,
    SUPABASE_JWT_ISSUER: `${status.API_URL}/auth/v1`,
    SUPABASE_JWKS_URL: `${status.API_URL}/auth/v1/.well-known/jwks.json`,
    VITE_SUPABASE_URL: status.API_URL,
    VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
    AUTH_MODE: 'supabase',
    VITE_AUTH_MODE: 'supabase',
    LOCAL_AUTH_BYPASS: 'false',
    VITE_LOCAL_AUTH_BYPASS: 'false',
  };
}

async function healthy(status: SharedSupabaseStatus, signal?: AbortSignal): Promise<void> {
  for (const path of ['/auth/v1/health', '/rest/v1/', '/storage/v1/status']) {
    const response = await fetch(`${status.API_URL}${path}`, {
      headers: {
        apikey: status.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
      },
      signal,
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Shared Supabase health failed: ${path} HTTP ${response.status}`);
  }
}

async function databaseContainer(project?: string): Promise<string> {
  const projectPattern = project ?? `(${PROJECT}|${LEGACY_PROJECT})`;
  const { stdout } = await execute(
    'docker',
    ['ps', '-a', '--filter', `name=^/supabase_db_${projectPattern}$`, '--format', '{{.ID}}'],
    { windowsHide: true }
  );
  return stdout.trim();
}

async function startSharedSupabase(
  run: typeof command,
  container: typeof databaseContainer,
  signal?: AbortSignal
): Promise<SharedSupabaseStatus> {
  const root = stateRoot();
  let startedContainer: string | undefined;
  try {
    await run(['start'], signal);
  } finally {
    startedContainer = await container(PROJECT);
    if (startedContainer) {
      await writeFile(join(root, 'managed'), startedContainer);
      await writeFile(join(root, 'incomplete'), startedContainer);
    }
  }
  if (!startedContainer) throw new Error('Shared Supabase database container is missing.');
  const current = await sharedSupabaseStatus(run, signal);
  await run(['migration', 'up', '--local'], signal);
  await rm(join(root, 'incomplete'), { force: true });
  return current;
}

/** Existing stacks are adopted without ownership of their shutdown or migrations. */
export async function ensureSharedSupabase(
  options: {
    run?: typeof command;
    health?: typeof healthy;
    watch?: () => Promise<void>;
    container?: typeof databaseContainer;
    signal?: AbortSignal;
  } = {}
): Promise<SharedSupabaseStatus> {
  return withSharedLifecycle(async () => {
    const run = options.run ?? command;
    const root = stateRoot();
    await mkdir(join(root, 'runs'), { recursive: true });
    await writeFile(join(root, 'last-run'), String(Date.now()));
    try {
      let current: SharedSupabaseStatus;
      try {
        current = await sharedSupabaseStatus(run, options.signal);
      } catch (error) {
        // A partial or unhealthy existing stack belongs to its current users.
        options.signal?.throwIfAborted();
        if (await (options.container ?? databaseContainer)())
          throw new Error(
            'Shared Supabase is unavailable; preserve the existing stack and inspect its health.',
            { cause: error }
          );
        current = await startSharedSupabase(
          run,
          options.container ?? databaseContainer,
          options.signal
        );
      }
      const incomplete = await readOptional(join(root, 'incomplete'));
      if (incomplete) {
        const project =
          Number(new URL(current.API_URL).port) === STACK_PORTS[0].api ? PROJECT : LEGACY_PROJECT;
        const initializingContainer = await (options.container ?? databaseContainer)(PROJECT);
        if (project === PROJECT && incomplete === initializingContainer)
          throw new Error(
            'Shared Supabase initialization is incomplete. Inspect the failed initialization before running a proof.'
          );
        if (incomplete !== initializingContainer) await rm(join(root, 'incomplete'));
      }
      await (options.health ?? healthy)(current, options.signal);
      await writeFile(join(root, 'runs', lease), String(process.pid));
      return current;
    } finally {
      await writeFile(join(root, 'last-run'), String(Date.now()));
      if (await readOptional(join(root, 'managed'))) await (options.watch ?? startIdleWatcher)();
    }
  }, options.signal);
}

/** Releasing a proof only updates activity; the shared database stays available. */
export async function releaseSharedSupabase(): Promise<void> {
  await withSharedLifecycle(async () => {
    const root = stateRoot();
    if (!(await readOptional(join(root, 'last-run')))) return;
    await rm(join(root, 'runs', lease), { force: true });
    await writeFile(join(root, 'last-run'), String(Date.now()));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** Called inside the same host queue as Docker proofs, then rechecks activity. */
export async function stopIdleSupabase(
  options: {
    now?: number;
    stop?: () => Promise<unknown>;
    container?: typeof databaseContainer;
  } = {}
): Promise<boolean> {
  return withSharedLifecycle(async () => {
    const root = stateRoot();
    const managed = await readOptional(join(root, 'managed'));
    if (!managed) return false;
    const last = await readOptional(join(root, 'last-run'));
    if (!last || (options.now ?? Date.now()) - Number(last) < SUPABASE_IDLE_MS) return false;
    for (const name of await readdir(join(root, 'runs'))) {
      const pid = Number(await readOptional(join(root, 'runs', name)));
      if (alive(pid)) return false;
      await rm(join(root, 'runs', name), { force: true });
    }
    if (managed !== (await (options.container ?? databaseContainer)(PROJECT))) {
      await rm(join(root, 'managed'));
      await rm(join(root, 'incomplete'), { force: true });
      return false;
    }
    if (options.stop) await options.stop();
    else await command(['stop', '--project-id', PROJECT]);
    await rm(join(root, 'managed'));
    await rm(join(root, 'incomplete'), { force: true });
    return true;
  });
}

async function startIdleWatcher(): Promise<void> {
  const root = stateRoot();
  if (!(await readOptional(join(root, 'managed')))) return;
  const watcher = await readOptional(join(root, 'watcher'));
  if (watcher && alive(Number(watcher))) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watch-idle'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: process.env,
  });
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
  await writeFile(join(root, 'watcher'), String(child.pid));
  child.unref();
}

async function queuedIdleCheck(): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(ROOT, 'scripts/heavy-run.mjs'),
      '--label',
      'supabase idle stop',
      '--',
      process.execPath,
      fileURLToPath(import.meta.url),
      '--idle-stop',
    ],
    {
      windowsHide: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, HEAVY_RUN_HELD: '' },
    }
  );
  if ((await child.exited) !== 0) throw new Error('Shared Supabase idle check failed.');
}

/** Recompute the deadline after every run release, including releases during an existing wait. */
export async function watchIdleSupabase(
  options: {
    wait?: (milliseconds: number) => Promise<unknown>;
    now?: () => number;
    check?: () => Promise<void>;
  } = {}
): Promise<void> {
  const root = stateRoot();
  const wait = options.wait ?? delay;
  const now = options.now ?? Date.now;
  while (await readOptional(join(root, 'managed'))) {
    const last = Number(await readOptional(join(root, 'last-run')));
    await wait(Math.max(0, last + SUPABASE_IDLE_MS - now()));
    try {
      await (options.check ?? queuedIdleCheck)();
    } catch (error) {
      // Docker availability can change while the watcher observes the same owned stack.
      await writeFile(join(root, 'idle-error.log'), String(error));
    }
    if (await readOptional(join(root, 'managed'))) {
      const updated = Number(await readOptional(join(root, 'last-run')));
      // A live proof can outlast the idle interval; its eventual release starts a fresh deadline.
      if (now() - updated >= SUPABASE_IDLE_MS) await wait(SUPABASE_IDLE_MS);
    }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === '--idle-stop') {
    await stopIdleSupabase();
  } else if (args[0] === '--watch-idle') {
    await watchIdleSupabase();
    await rm(join(stateRoot(), 'watcher'), { force: true });
  } else {
    const command = args[0] === '--' ? args.slice(1) : args;
    if (!command[0] || command[0].startsWith('-'))
      throw new Error('Usage: shared-supabase.ts -- command [args...]');
    const status = await ensureSharedSupabase();
    try {
      const child = Bun.spawn(command, {
        windowsHide: true,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: {
          ...process.env,
          ...sharedSupabaseEnvironment(status),
        },
      });
      process.exitCode = await child.exited;
    } finally {
      await releaseSharedSupabase();
    }
  }
}

if (import.meta.main) await main();
