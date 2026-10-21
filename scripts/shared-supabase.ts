import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as z from 'zod';
import { processIdentity } from '../e2e/nous/processIdentity';
import { prepareIsolatedProof } from './isolated-proof-supabase';
import {
  checkoutTracksMain,
  migrationStore,
  proofMigrationSnapshot,
  reconcileProofMigrations,
  stageSharedStartup,
} from './proof-migrations';

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
  PROOF_WORKDIR: z.string().optional(),
});
export type SharedSupabaseStatus = z.infer<typeof statusSchema>;
const lease = `${process.pid}-${crypto.randomUUID()}`;
let isolatedProof: { workdir: string; project: string; container?: string } | undefined;
const isolatedOwnerSchema = z.object({
  workdir: z.string(),
  project: z.uuid(),
  container: z.string().min(1).optional(),
  repoRoot: z.string(),
});

function isolatedOwnerPath(): string | undefined {
  const data = process.env.NOUS_E2E_DATA;
  return data
    ? join(
        stateRoot(),
        'proofs',
        `${createHash('sha256').update(resolve(data)).digest('hex')}.json`
      )
    : undefined;
}

async function recordedIsolatedProof(): Promise<z.infer<typeof isolatedOwnerSchema> | undefined> {
  const path = isolatedOwnerPath();
  if (!path || process.env.NOUS_PROOF_SUPABASE_WORKDIR) return undefined;
  const text = await readOptional(path);
  if (!text) return undefined;
  const owner = isolatedOwnerSchema.parse(JSON.parse(text));
  if (
    owner.repoRoot !== ROOT ||
    resolve(owner.workdir) !== resolve(stateRoot(), 'isolated', owner.project)
  )
    throw new Error('Isolated proof ownership does not match this worktree.');
  return owner;
}

async function persistIsolatedProof(proof: NonNullable<typeof isolatedProof>): Promise<void> {
  const record = JSON.stringify({ ...proof, repoRoot: ROOT });
  await writeFile(join(proof.workdir, 'owner.json'), record);
  const path = isolatedOwnerPath();
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, record);
  }
}

async function settleIsolatedOwnership(proof: NonNullable<typeof isolatedProof>): Promise<void> {
  if (!proof.container) proof.container = (await databaseContainer(proof.project)) || undefined;
  await persistIsolatedProof(proof);
}
const processOwnerSchema = z.object({
  pid: z.number().int().positive(),
  identity: z.string().min(1),
});
type ProcessOwner = z.infer<typeof processOwnerSchema>;
let ownIdentity: Promise<ProcessOwner> | undefined;

async function processOwner(pid: number): Promise<ProcessOwner | undefined> {
  const identity = await processIdentity(pid, { includeCommand: false });
  return identity ? { pid, identity } : undefined;
}

function currentOwner(): Promise<ProcessOwner> {
  ownIdentity ??= processOwner(process.pid).then(owner => {
    if (!owner) throw new Error('The current proof process could not be identified.');
    return owner;
  });
  return ownIdentity;
}

async function ownerAlive(text: string): Promise<boolean> {
  const owner = processOwnerSchema.parse(JSON.parse(text));
  if (!alive(owner.pid)) return false;
  const current = owner.pid === process.pid ? await currentOwner() : await processOwner(owner.pid);
  return current?.identity === owner.identity;
}
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
  const record = await readOptional(join(reservation, previous));
  if (record && !(await ownerAlive(record))) await removeReservation(reservation, previous);
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
    await writeFile(join(prepared, owner), JSON.stringify(await currentOwner()));
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

async function command(
  args: string[],
  signal?: AbortSignal,
  explicitWorkdir?: string
): Promise<string> {
  const binary = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'supabase.exe' : 'supabase'
  );
  let workdir = explicitWorkdir ?? ROOT;
  if (!explicitWorkdir) {
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
  const workdir = isolatedProof?.workdir ?? process.env.NOUS_PROOF_SUPABASE_WORKDIR;
  const status = statusSchema.parse(
    JSON.parse(await run(['status', '--output', 'json'], signal, workdir))
  );
  if (workdir) status.PROOF_WORKDIR = workdir;
  assertLocalProofStatus(status);
  return status;
}

export function assertLocalProofStatus(status: SharedSupabaseStatus): void {
  const api = new URL(status.API_URL);
  const db = new URL(status.DB_URL);
  if (
    ![api, db].every(url => ['localhost', '127.0.0.1'].includes(url.hostname)) ||
    !(status.PROOF_WORKDIR
      ? dirname(resolve(status.PROOF_WORKDIR)) === resolve(stateRoot(), 'isolated') &&
        z.uuid().safeParse(basename(status.PROOF_WORKDIR)).success
      : STACK_PORTS.some(ports => Number(api.port) === ports.api && Number(db.port) === ports.db))
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
    NOUS_PROOF_SUPABASE_WORKDIR: status.PROOF_WORKDIR ?? '',
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

async function hasStackOwnership(): Promise<boolean> {
  return Boolean(
    (await readOptional(join(stateRoot(), 'managed'))) ||
      (await readOptional(join(stateRoot(), 'starting')))
  );
}

/** Startup intent survives a failed Docker inspection until the owned identity can be recorded. */
async function settleStartOwnership(container: typeof databaseContainer): Promise<void> {
  const root = stateRoot();
  if (!(await readOptional(join(root, 'starting')))) return;
  const current = await container(PROJECT);
  const recorded = await readOptional(join(root, 'managed'));
  if (current && (!recorded || recorded === current)) {
    await writeFile(join(root, 'managed'), current);
    await writeFile(join(root, 'incomplete'), current);
  }
  await rm(join(root, 'starting'), { force: true });
}

async function startSharedSupabase(
  run: typeof command,
  container: typeof databaseContainer,
  signal?: AbortSignal
): Promise<SharedSupabaseStatus> {
  const root = stateRoot();
  const workdir = await stageSharedStartup(ROOT, root);
  // Admission confirmed no database remains; the next start establishes new ownership.
  await rm(join(root, 'managed'), { force: true });
  await rm(join(root, 'incomplete'), { force: true });
  await writeFile(join(root, 'starting'), PROJECT);
  try {
    await run(['start'], signal, workdir);
  } finally {
    await settleStartOwnership(container);
  }
  if (!(await readOptional(join(root, 'managed'))))
    throw new Error('Shared Supabase database container is missing.');
  const current = await sharedSupabaseStatus(run, signal);
  await rm(join(root, 'incomplete'), { force: true });
  return current;
}

async function isolateProof(signal?: AbortSignal): Promise<SharedSupabaseStatus> {
  isolatedProof = await prepareIsolatedProof(ROOT, stateRoot());
  await persistIsolatedProof(isolatedProof);
  try {
    await command(
      ['start', '-x', 'studio,inbucket,imgproxy,logflare,vector,supavisor,realtime,edge-runtime'],
      signal,
      isolatedProof.workdir
    );
    isolatedProof.container = await databaseContainer(isolatedProof.project);
    if (!isolatedProof.container) throw new Error('Isolated proof database container is missing.');
    const status = await sharedSupabaseStatus(command, signal);
    await healthy(status, signal);
    await persistIsolatedProof(isolatedProof);
    return status;
  } catch (error) {
    const failed = isolatedProof;
    isolatedProof = undefined;
    try {
      await settleIsolatedOwnership(failed);
      if (failed.container) {
        await stopIsolatedProof(failed);
        const path = isolatedOwnerPath();
        if (path) await rm(path, { force: true });
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Isolated Supabase startup failed; its ownership record was preserved for diagnosis.'
      );
    }
    throw error;
  }
}

async function stopIsolatedProof(proof: NonNullable<typeof isolatedProof>): Promise<void> {
  if (!proof.container) await settleIsolatedOwnership(proof);
  const current = await databaseContainer(proof.project);
  if (!current) return;
  if (proof.container !== current)
    throw new Error('Isolated proof container identity changed; preserve it for diagnosis.');
  await command(['stop'], undefined, proof.workdir);
}

async function assertInitialized(
  current: SharedSupabaseStatus,
  container: typeof databaseContainer
): Promise<void> {
  const root = stateRoot();
  await settleStartOwnership(container);
  const incomplete = await readOptional(join(root, 'incomplete'));
  if (!incomplete) return;
  const project =
    Number(new URL(current.API_URL).port) === STACK_PORTS[0].api ? PROJECT : LEGACY_PROJECT;
  const initializingContainer = await container(PROJECT);
  if (project === PROJECT && incomplete === initializingContainer)
    throw new Error(
      'Shared Supabase initialization is incomplete. Inspect the failed initialization before running a proof.'
    );
  if (incomplete !== initializingContainer) await rm(join(root, 'incomplete'));
}

/** The lifecycle owner reconciles main's migrations before shared admission. */
export async function ensureSharedSupabase(
  options: {
    run?: typeof command;
    health?: typeof healthy;
    watch?: () => Promise<void>;
    container?: typeof databaseContainer;
    snapshot?: typeof proofMigrationSnapshot;
    reconcile?: (status: SharedSupabaseStatus, signal?: AbortSignal) => Promise<boolean>;
    isolate?: typeof isolateProof;
    signal?: AbortSignal;
  } = {}
): Promise<SharedSupabaseStatus> {
  return withSharedLifecycle(async () => {
    const run = options.run ?? command;
    const root = stateRoot();
    await mkdir(join(root, 'runs'), { recursive: true });
    await writeFile(join(root, 'last-run'), String(Date.now()));
    let dedicated = false;
    try {
      let current: SharedSupabaseStatus;
      if (isolatedProof || process.env.NOUS_PROOF_SUPABASE_WORKDIR) {
        dedicated = true;
        current = await sharedSupabaseStatus(run, options.signal);
        await (options.health ?? healthy)(current, options.signal);
        return current;
      }
      if (await recordedIsolatedProof())
        throw new Error(
          'A dedicated Supabase project is recorded for this proof. Run bun run e2e/nous/stack.ts --stop with the same NOUS_E2E_DATA before starting another proof.'
        );
      const snapshot = await (options.snapshot ?? proofMigrationSnapshot)(ROOT, options.signal);
      if (!checkoutTracksMain(snapshot)) {
        dedicated = true;
        return await (options.isolate ?? isolateProof)(options.signal);
      }
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
      await assertInitialized(current, options.container ?? databaseContainer);
      await (options.health ?? healthy)(current, options.signal);
      const reconciled = options.reconcile
        ? await options.reconcile(current, options.signal)
        : await reconcileProofMigrations(
            snapshot,
            migrationStore(current.DB_URL, options.signal),
            options.signal
          );
      if (!reconciled) {
        dedicated = true;
        return await (options.isolate ?? isolateProof)(options.signal);
      }
      await writeFile(join(root, 'runs', lease), JSON.stringify(await currentOwner()));
      return current;
    } finally {
      await writeFile(join(root, 'last-run'), String(Date.now()));
      if (!dedicated && (await hasStackOwnership())) await (options.watch ?? startIdleWatcher)();
    }
  }, options.signal);
}

/** Releasing a proof only updates activity; the shared database stays available. */
export async function releaseSharedSupabase(): Promise<void> {
  await withSharedLifecycle(async () => {
    const proof = isolatedProof ?? (await recordedIsolatedProof());
    if (proof) {
      await stopIsolatedProof(proof);
      isolatedProof = undefined;
      const path = isolatedOwnerPath();
      if (path) await rm(path, { force: true });
      return;
    }
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
    await settleStartOwnership(options.container ?? databaseContainer);
    const managed = await readOptional(join(root, 'managed'));
    if (!managed) return false;
    const last = await readOptional(join(root, 'last-run'));
    if (!last || (options.now ?? Date.now()) - Number(last) < SUPABASE_IDLE_MS) return false;
    for (const name of await readdir(join(root, 'runs'))) {
      const record = await readOptional(join(root, 'runs', name));
      if (record && (await ownerAlive(record))) return false;
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
  if (!(await hasStackOwnership())) return;
  const watcher = await readOptional(join(root, 'watcher'));
  if (watcher && (await ownerAlive(watcher))) return;
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
  if (child.pid === undefined) throw new Error('The idle watcher has no process identifier.');
  const owner = await processOwner(child.pid);
  if (!owner) throw new Error('The idle watcher could not be identified.');
  await writeFile(join(root, 'watcher'), JSON.stringify(owner));
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
  while (await hasStackOwnership()) {
    const last = Number(await readOptional(join(root, 'last-run')));
    await wait(Math.max(0, last + SUPABASE_IDLE_MS - now()));
    try {
      await (options.check ?? queuedIdleCheck)();
    } catch (error) {
      // Docker availability can change while the watcher observes the same owned stack.
      await writeFile(join(root, 'idle-error.log'), String(error));
    }
    if (await hasStackOwnership()) {
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
