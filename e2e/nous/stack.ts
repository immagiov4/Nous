import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import * as z from 'zod';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_URL = 'http://127.0.0.1:5173';
export const BACKEND_URL = 'http://127.0.0.1:3301';
const PROJECT_ID = 'nous-playtest';
export const STACK_STAGE_READINESS_LIMIT_MS = 180_000;
export const STACK_SHUTDOWN_GRACE_MS = 10_000;
export const STACK_READINESS_POLL_INTERVAL_MS = 500;
// These addresses reuse the working hands spike's isolated port allocation.
const PORTS = { api: 55321, db: 55322, shadow: 55320, studio: 55323, mail: 55324 };
const statusSchema = z.object({
  API_URL: z.string(),
  DB_URL: z.string(),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
});
export type StackStatus = z.infer<typeof statusSchema>;
type StackClock = {
  now: () => number;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
type AppShutdownOptions = {
  platform?: NodeJS.Platform;
  identity?: typeof processIdentity;
  kill?: typeof process.kill;
  clock?: StackClock;
};
const stackClock: StackClock = {
  now: () => performance.now(),
  wait: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};
const executeFile = promisify(execFile);
const ownedProcessSchema = z.object({
  pid: z.number().int().positive(),
  repoRoot: z.literal(REPO_ROOT),
  identity: z.string().min(1),
});
const stackConfigSchema = z.object({
  project_id: z.literal(PROJECT_ID),
  api: z.object({ port: z.literal(PORTS.api) }),
  db: z.object({ port: z.literal(PORTS.db), shadow_port: z.literal(PORTS.shadow) }),
  studio: z.object({ port: z.literal(PORTS.studio) }),
  inbucket: z.object({ port: z.literal(PORTS.mail) }),
  auth: z.object({ email: z.object({ smtp: z.object({ enabled: z.literal(false) }) }) }),
});

/** Birth time and command distinguish an owned server from a recycled PID. */
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') {
    const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ startedAt = $p.CreationDate.ToUniversalTime().ToString('o'); command = $p.CommandLine } | ConvertTo-Json -Compress }`;
    const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
    });
    if (!stdout.trim()) return undefined;
    return JSON.stringify(
      z
        .object({ startedAt: z.string().min(1), command: z.string().min(1) })
        .parse(JSON.parse(stdout))
    );
  }
  try {
    const { stdout } = await executeFile(
      'ps',
      ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'args='],
      { env: { ...process.env, LC_ALL: 'C' } }
    );
    return stdout.trim() || undefined;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    throw error;
  }
}

async function ownedProcess(name: string) {
  return readFile(join(dataRoot(), 'stack', `${name}-pid.json`), 'utf8')
    .then(text => ownedProcessSchema.parse(JSON.parse(text)))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
}

export function dataRoot(): string {
  if (!process.env.NOUS_E2E_DATA) throw new Error('NOUS_E2E_DATA is unset.');
  const root = resolve(process.env.NOUS_E2E_DATA);
  const fromRepo = relative(REPO_ROOT, root);
  if (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo))
    throw new Error('NOUS_E2E_DATA must be outside the repository.');
  return root;
}

export function assertIsolatedStatus(status: StackStatus): void {
  for (const [address, port] of [
    [status.API_URL, PORTS.api],
    [status.DB_URL, PORTS.db],
  ] as const) {
    const url = new URL(address);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || Number(url.port) !== port)
      throw new Error('Supabase status does not match the isolated playtest project.');
  }
}

async function configureStack(): Promise<string> {
  const workdir = join(dataRoot(), 'stack');
  const supabase = join(workdir, 'supabase');
  await mkdir(supabase, { recursive: true });
  const source = await readFile(join(REPO_ROOT, 'supabase/config.toml'), 'utf8');
  const config =
    source
      .replace('project_id = "nous-reader"', `project_id = "${PROJECT_ID}"`)
      .replace('port = 54321', `port = ${PORTS.api}`)
      .replace('port = 54322', `port = ${PORTS.db}`)
      .replace('shadow_port = 54320', `shadow_port = ${PORTS.shadow}`)
      .replace('port = 54323', `port = ${PORTS.studio}`)
      .replace('[auth.email.smtp]\nenabled = true', '[auth.email.smtp]\nenabled = false')
      .replace('[auth.email.smtp]\r\nenabled = true', '[auth.email.smtp]\r\nenabled = false') +
    `\n[analytics]\nenabled = false\n\n[inbucket]\nenabled = true\nport = ${PORTS.mail}\n`;
  stackConfigSchema.parse(parseToml(config));
  const existing = await readFile(join(supabase, 'config.toml'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  );
  if (existing !== undefined) stackConfigSchema.parse(parseToml(existing));
  await writeFile(join(supabase, 'config.toml'), config);
  await cp(join(REPO_ROOT, 'supabase', 'templates'), join(supabase, 'templates'), {
    recursive: true,
  });
  return workdir;
}

// The repository-local CLI binary avoids resolving executables through a mutable PATH.
const SUPABASE_CLI_PATH = join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.exe' : 'supabase'
);

async function supabaseCommand(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(SUPABASE_CLI_PATH, [...args, '--workdir', join(dataRoot(), 'stack')], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const abort = () => terminateChild(child);
  signal?.addEventListener('abort', abort, { once: true });
  // stdout carries machine-readable status with service keys and JWT secrets: parse it, never log it.
  const captureOutput = async (stream: NonNullable<typeof child.stdout>, logPath?: string) => {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      chunks.push(text);
      if (logPath) await appendFile(logPath, text);
    }
    const final = decoder.decode();
    chunks.push(final);
    if (logPath) await appendFile(logPath, final);
    return chunks.join('');
  };
  const [stdout, stderr, code] = await Promise.all([
    captureOutput(child.stdout),
    captureOutput(child.stderr, join(dataRoot(), 'stack', 'supabase.log')),
    exited,
  ]).finally(() => signal?.removeEventListener('abort', abort));
  if (code !== 0) {
    recordDiagnostic('stack-supabase-command', new Error(stderr));
    await writeFile(join(dataRoot(), 'stack', 'supabase-error.log'), stderr);
    throw stageError('Supabase', `${args[0]} exited (${code})`);
  }
  return stdout;
}

function terminateChild(child: { pid?: number; kill(): unknown }, detached = false): void {
  if (process.platform === 'win32' && child.pid) {
    executeFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(error => recordDiagnostic('stack-termination', error));
  } else if (detached && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  } else child.kill();
}

function stageError(stage: string, detail: string): Error {
  const logPath = join(dataRoot(), 'stack', `${stage.toLowerCase()}.log`);
  return new Error(`Playtest ${stage} readiness failed: ${detail}. Process log: ${logPath}`);
}

/** A stage owns one deadline across all of its commands and readiness checks. */
export async function runStackStage<T>(options: {
  name: string;
  work: (signal: AbortSignal) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  limitMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = stageError(options.name, 'stage limit expired');
      reject(error);
      controller.abort(error);
    }, options.limitMs ?? STACK_STAGE_READINESS_LIMIT_MS);
  });
  try {
    return await Promise.race([options.work(controller.signal), expired]);
  } catch (error) {
    recordDiagnostic(`stack-${options.name.toLowerCase()}`, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function stackStatus(signal?: AbortSignal): Promise<StackStatus> {
  const status = statusSchema.parse(
    JSON.parse(await supabaseCommand(['status', '--output', 'json'], signal))
  );
  assertIsolatedStatus(status);
  return status;
}

async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', error => {
      recordDiagnostic('stack-port', error);
      reject(new Error(`Playtest app port ${port} is occupied.`, { cause: error }));
    });
    server.listen(port, '0.0.0.0', () => server.close(() => resolvePort()));
  });
}

/** Pace HTTP checks while preserving the stage abort and immediate child-exit failure. */
export async function waitForReadiness(options: {
  url: string;
  exited: Promise<never>;
  signal?: AbortSignal;
  wait?: StackClock['wait'];
}): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const wait = options.wait ?? stackClock.wait;
  try {
    for (;;) {
      signal.throwIfAborted();
      const response = await Promise.race([
        // Refused connections are expected while the server starts; only the terminal stage failure is diagnosed.
        fetch(options.url, { signal }).catch(() => undefined),
        options.exited,
      ]);
      await Promise.race([response?.body?.cancel(), options.exited]);
      if (response?.ok) return;
      await Promise.race([wait(STACK_READINESS_POLL_INTERVAL_MS, signal), options.exited]);
    }
  } finally {
    controller.abort();
  }
}

export async function startServer(
  name: string,
  args: string[],
  readinessUrl: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const logPath = join(dataRoot(), 'stack', `${name}.log`);
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  let startupComplete = false;
  // Register exit/error listeners immediately: even an exit before the PID write must settle readiness.
  const exited = new Promise<never>((_resolve, reject) => {
    const fail = (detail: string) => {
      if (startupComplete) return;
      reject(stageError(name, detail));
    };
    child.once('error', error => {
      fail(error.message);
    });
    child.once('exit', (code, signal) => {
      fail(`process exited (${signal ?? code})`);
    });
  });
  // Keep a rejection handled while the PID record is being written.
  void exited.catch(() => {});
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      terminateChild(child, true);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    if (!child.pid) return await exited;
    const identity = await Promise.race([processIdentity(child.pid), exited, interrupted]);
    if (!identity) return await exited;
    await writeFile(
      join(dataRoot(), 'stack', `${name}-pid.json`),
      JSON.stringify({ pid: child.pid, repoRoot: REPO_ROOT, identity })
    );
    process.stderr.write(`[playtest] readiness: ${name} ${readinessUrl}\n`);
    await waitForReadiness({
      url: readinessUrl,
      signal,
      exited: Promise.race([exited, interrupted]),
    });
    startupComplete = true;
    child.unref();
    return child.pid;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) terminateChild(child, true);
    throw error;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Sorted names and byte lengths make names and contents unambiguous hash inputs. */
export async function migrationFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    // Code-point order keeps migration fingerprints stable across host locales.
    .sort((a, b) => (a < b ? -1 : Number(a > b)));
  for (const name of files) {
    const contents = await readFile(join(directory, name));
    hash.update(JSON.stringify([name, contents.length]));
    hash.update(contents);
  }
  return hash.digest('hex');
}

/** The destination is fixed inside the validated external isolated workdir. */
export async function mirrorMigrations(source = join(REPO_ROOT, 'supabase', 'migrations')) {
  const workdir = join(dataRoot(), 'stack');
  const destination = join(workdir, 'supabase', 'migrations');
  const fingerprint = await migrationFingerprint(source);
  const marker = join(workdir, 'migrations.sha256');
  const previous = await readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  return { fingerprint, marker, changed: previous !== fingerprint };
}

/** Status is identity-checked before reset; the fingerprint commits only after successful apply. */
export async function initializeIsolatedDatabase(
  options: { signal?: AbortSignal; command?: typeof supabaseCommand; migrations?: string } = {}
): Promise<StackStatus> {
  await configureStack();
  const migrations = await mirrorMigrations(options.migrations);
  await writeFile(join(dataRoot(), 'stack', 'supabase.log'), '');
  const command = options.command ?? supabaseCommand;
  process.stderr.write('[playtest] Supabase: starting nous-playtest\n');
  await command(['start'], options.signal);
  const current = statusSchema.parse(
    JSON.parse(await command(['status', '--output', 'json'], options.signal))
  );
  assertIsolatedStatus(current);
  if (migrations.changed) await command(['db', 'reset', '--local'], options.signal);
  await command(['migration', 'up', '--local'], options.signal);
  await writeFile(migrations.marker, migrations.fingerprint);
  return current;
}

/** Explicit workdir and URLs keep every database operation off the developer's project. */
export async function ensureStack(
  options: {
    shutdown?: AppShutdownOptions;
    initializeSupabase?: (signal: AbortSignal) => Promise<StackStatus>;
    requireFreePort?: typeof requireFreePort;
    startServer?: typeof startServer;
  } = {}
): Promise<void> {
  process.stderr.write('[playtest] App servers: stopping owned processes\n');
  await stopAppServers(options.shutdown);
  process.stderr.write('[playtest] Supabase: configuring isolated project\n');
  const status = await runStackStage({
    name: 'Supabase',
    work: options.initializeSupabase ?? (signal => initializeIsolatedDatabase({ signal })),
  });
  process.stderr.write('[playtest] Supabase: ready; migrations applied\n');
  const env = {
    ...process.env,
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
    BACKEND_HOST: '127.0.0.1',
    BACKEND_PORT: new URL(BACKEND_URL).port,
    VITE_BACKEND_HOST: '127.0.0.1',
    VITE_BACKEND_PORT: new URL(BACKEND_URL).port,
    CORS_ALLOWED_ORIGINS: APP_URL,
    CODEX_APP_SERVER_ENABLED: 'false',
  };
  for (const server of [
    {
      name: 'backend',
      url: `${BACKEND_URL}/health`,
      args: [join(REPO_ROOT, 'apps/backend/src/server.ts')],
    },
    {
      name: 'frontend',
      url: APP_URL,
      args: [
        '--bun',
        join(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
        '--config',
        join(REPO_ROOT, 'apps/web/vite.config.ts'),
        '--host',
        '127.0.0.1',
      ],
    },
  ]) {
    await runStackStage({
      name: server.name,
      env,
      work: async signal => {
        await (options.requireFreePort ?? requireFreePort)(Number(new URL(server.url).port));
        process.stderr.write(`[playtest] ${server.name}: starting\n`);
        await (options.startServer ?? startServer)(
          server.name,
          server.args,
          server.url,
          env,
          signal
        );
        process.stderr.write(`[playtest] readiness: ${server.name} ready\n`);
      },
    });
  }
  process.stderr.write('[playtest] readiness: stack ready\n');
}

/** Wait for the entire owned group, including descendants whose leader has exited. */
async function stopProcessGroup(
  pid: number,
  kill: typeof process.kill,
  clock: StackClock
): Promise<void> {
  const deadline = clock.now() + STACK_SHUTDOWN_GRACE_MS;
  try {
    kill(-pid, 'SIGTERM');
    for (;;) {
      kill(-pid, 0);
      const remaining = deadline - clock.now();
      if (remaining <= 0) {
        kill(-pid, 'SIGKILL');
        return;
      }
      await clock.wait(Math.min(STACK_READINESS_POLL_INTERVAL_MS, remaining));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Startup and explicit shutdown share the identity-verified app-server termination path. */
async function stopAppServers(options: AppShutdownOptions = {}): Promise<void> {
  for (const name of ['frontend', 'backend']) {
    const pidPath = join(dataRoot(), 'stack', `${name}-pid.json`);
    const owned = await ownedProcess(name);
    if (!owned) continue;
    const identity = await (options.identity ?? processIdentity)(owned.pid);
    if (identity === undefined) {
      await rm(pidPath);
      continue;
    }
    if (identity !== owned.identity)
      throw new Error(`Could not safely stop playtest ${name}: process identity changed.`);
    if ((options.platform ?? process.platform) === 'win32') {
      const expected = z
        .object({ startedAt: z.string(), command: z.string() })
        .parse(JSON.parse(owned.identity));
      const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${owned.pid}'; if ($p) { if ($p.CreationDate.ToUniversalTime().ToString('o') -cne '${expected.startedAt.replaceAll("'", "''")}' -or $p.CommandLine -cne '${expected.command.replaceAll("'", "''")}') { exit 1 }; taskkill /PID ${owned.pid} /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 } }`;
      try {
        await executeFile('powershell.exe', ['-NoProfile', '-Command', command], {
          windowsHide: true,
        });
      } catch (error) {
        recordDiagnostic('stack-shutdown', error);
        throw new Error(`Could not safely stop playtest ${name}.`, { cause: error });
      }
    } else {
      await stopProcessGroup(owned.pid, options.kill ?? process.kill, options.clock ?? stackClock);
    }
    await rm(pidPath);
  }
}

/** Stop only the recorded app processes and the explicitly named isolated Supabase project. */
export async function stopStack(
  options: AppShutdownOptions & {
    stopSupabase?: () => Promise<unknown>;
  } = {}
): Promise<void> {
  const savedConfig = await readFile(join(dataRoot(), 'stack', 'supabase', 'config.toml'), 'utf8');
  stackConfigSchema.parse(parseToml(savedConfig));
  await stopAppServers(options);
  if (options.stopSupabase) await options.stopSupabase();
  else await supabaseCommand(['stop', '--project-id', PROJECT_ID]);
}

if (import.meta.main) {
  if (process.argv[2] !== '--stop')
    throw new Error('Use --stop to stop the isolated playtest stack.');
  await stopStack();
}
