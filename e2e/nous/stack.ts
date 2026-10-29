import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import * as z from 'zod';
import type { CreateAppOptions } from '../../apps/backend/src/index';
import type { InMemoryProjectStore } from '../../apps/backend/tests/helpers/inMemoryProjectStore';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import {
  ensureSharedSupabase,
  releaseSharedSupabase,
  STACK_READINESS_POLL_INTERVAL_MS,
  sharedSupabaseEnvironment,
  sharedSupabaseStatus,
} from '../../scripts/shared-supabase';
import { processIdentity as readProcessIdentity } from './processIdentity';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_URL = 'http://127.0.0.1:5173';
export const BACKEND_URL = 'http://127.0.0.1:3301';
export const STACK_STAGE_READINESS_LIMIT_MS = 180_000;
export const STACK_SHUTDOWN_GRACE_MS = 10_000;
export type { SharedSupabaseStatus as StackStatus } from '../../scripts/shared-supabase';
export { STACK_READINESS_POLL_INTERVAL_MS } from '../../scripts/shared-supabase';

import type { SharedSupabaseStatus as StackStatus } from '../../scripts/shared-supabase';

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
// Process identity and termination commands retain execFile's 1 MiB output budget.
const EXEC_FILE_MAX_BUFFER_BYTES = 1024 * 1024;

async function captureCommandOutput(
  stream: ReadableStream<Uint8Array>,
  options: { logPath?: string; maxBytes?: number; streamName?: string } = {}
): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let byteCount = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (options.maxBytes !== undefined && byteCount > options.maxBytes) {
        throw new RangeError(`${options.streamName} maxBuffer length exceeded`);
      }
      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      if (options.logPath) await appendFile(options.logPath, text);
    }
    const final = decoder.decode();
    chunks.push(final);
    if (options.logPath) await appendFile(options.logPath, final);
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function executeFile(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean } = {}
): Promise<{ stdout: string }> {
  const child = Bun.spawn([executable, ...args], {
    ...options,
    windowsHide: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      captureCommandOutput(child.stdout, {
        maxBytes: EXEC_FILE_MAX_BUFFER_BYTES,
        streamName: 'stdout',
      }),
      captureCommandOutput(child.stderr, {
        maxBytes: EXEC_FILE_MAX_BUFFER_BYTES,
        streamName: 'stderr',
      }),
      child.exited,
    ]);
    if (code !== 0) throw Object.assign(new Error(stderr), { code });
    return { stdout };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await child.exited;
    throw error;
  }
}
const ownedProcessSchema = z.object({
  pid: z.number().int().positive(),
  repoRoot: z.string().min(1),
  identity: z.string().min(1),
});

/** App shutdown requires the command line captured in its ownership registry. */
async function processIdentity(pid: number): Promise<string | undefined> {
  const identity = await readProcessIdentity(pid);
  if (identity && process.platform === 'win32') {
    z.object({ startedAt: z.string().min(1), command: z.string().min(1) }).parse(
      JSON.parse(identity)
    );
  }
  return identity;
}
async function ownedProcess(name: string) {
  return readFile(join(dataRoot(), 'stack', `${name}-pid.json`), 'utf8')
    .then(text => {
      const owned = ownedProcessSchema.parse(JSON.parse(text));
      if (owned.repoRoot !== REPO_ROOT)
        throw new Error(
          `Playtest ${name} is owned by ${owned.repoRoot}. Run bun run e2e/nous/stack.ts --stop from that worktree with NOUS_E2E_DATA=${dataRoot()}, then retry from ${REPO_ROOT}.`
        );
      return owned;
    })
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

export { assertLocalProofStatus as assertIsolatedStatus } from '../../scripts/shared-supabase';

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
  signal?.throwIfAborted();
  return sharedSupabaseStatus(undefined, signal);
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
  let child: Bun.Subprocess<'ignore', number, number>;
  try {
    child = Bun.spawn([process.execPath, ...args], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      windowsHide: true,
      stdin: 'ignore',
      stdout: log,
      stderr: log,
    });
  } finally {
    closeSync(log);
  }
  const exited = child.exited.then<never>(code => {
    throw stageError(name, `process exited (${child.signalCode ?? code})`);
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
    child.unref();
    return child.pid;
  } catch (error) {
    if (child.exitCode === null) terminateChild(child, true);
    throw error;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Every proof reuses the shared stack; prepare() creates its own disposable account. */
async function initializeSharedDatabase(
  options: { signal?: AbortSignal } = {}
): Promise<StackStatus> {
  options.signal?.throwIfAborted();
  await mkdir(join(dataRoot(), 'stack'), { recursive: true });
  return ensureSharedSupabase({ signal: options.signal });
}

/** Each proof owns its app processes and disposable users on the shared database. */
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
  process.stderr.write('[playtest] Supabase: checking shared local project\n');
  const status = await runStackStage({
    name: 'Supabase',
    work: options.initializeSupabase ?? (signal => initializeSharedDatabase({ signal })),
  });
  process.stderr.write('[playtest] Supabase: shared project ready\n');
  const env = {
    ...process.env,
    ...sharedSupabaseEnvironment(status),
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
      args: [join(REPO_ROOT, 'e2e/nous/backend.ts')],
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
      const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${owned.pid}'; if ($p) { if ($p.CreationDate.ToUniversalTime().ToString('o') -cne '${expected.startedAt.replaceAll("'", "''")}' -or $p.CommandLine -cne '${expected.command.replaceAll("'", "''")}') { exit 1 }; $termination = Start-Process -FilePath 'taskkill.exe' -ArgumentList '/PID', '${owned.pid}', '/T', '/F' -WindowStyle Hidden -Wait -PassThru; if ($termination.ExitCode -ne 0) { exit 1 } }`;
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

/** Stop recorded app processes and release activity without stopping shared Supabase. */
export async function stopStack(
  options: AppShutdownOptions & {
    stopSupabase?: () => Promise<unknown>;
  } = {}
): Promise<void> {
  await stopAppServers(options);
  if (options.stopSupabase) await options.stopSupabase();
  else await releaseSharedSupabase();
}

/** Deterministic full-app browser profile; run each proof in its own process. */
export async function withMemoryProjectBrowserStack<T>(
  options: { userId: string; appOptions: CreateAppOptions },
  scenario: (context: { page: Page; store: InMemoryProjectStore; url: string }) => Promise<T>
): Promise<T> {
  const authMode = 'local-bypass' as const;
  const previousEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    LOCAL_USER_ID: process.env.LOCAL_USER_ID,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_MODE: authMode,
    LOCAL_USER_ID: options.userId,
  });
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const { withMutedAudio } = await import('../../scripts/browser-audio');
  const { createApp } = await import('../../apps/backend/src/index');
  const { InMemoryProjectStore } = await import(
    '../../apps/backend/tests/helpers/inMemoryProjectStore'
  );
  const { setProjectStoreForTesting } = await import(
    '../../apps/backend/src/projects/projectStore'
  );
  const store = new InMemoryProjectStore();
  setProjectStoreForTesting(store);
  const backend = createHttpServer();
  let frontend: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const address = backend.address();
    if (!address || typeof address === 'string')
      throw new Error('Browser proof backend has no port.');
    frontend = await createServer({
      configFile: join(REPO_ROOT, 'apps/web/vite.config.ts'),
      mode: 'test',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        proxy: {
          '/api': { target: `http://127.0.0.1:${address.port}`, changeOrigin: true },
        },
      },
    });
    await frontend.listen();
    const url = frontend.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!url) throw new Error('Browser proof frontend has no URL.');
    process.env.CORS_ALLOWED_ORIGINS = url;
    backend.on('request', createApp(options.appOptions));
    browser = await chromium.launch(withMutedAudio({ headless: true }));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // Provider calls belong to real-provider proofs, not this deterministic profile.
    await page.route('**/api/openrouter/**', route => route.fulfill({ status: 503, body: '{}' }));
    await page.route('**/api/images/**', route => route.fulfill({ status: 503, body: '{}' }));
    await page.addInitScript(
      config => {
        Object.assign(globalThis, { __NOUS_RUNTIME_CONFIG__: config });
      },
      { authMode, backendUrl: url }
    );
    return await scenario({ page, store, url });
  } finally {
    await browser?.close();
    await frontend?.close();
    if (backend.listening) {
      await new Promise<void>((resolve, reject) =>
        backend.close(error => (error ? reject(error) : resolve()))
      );
    }
    setProjectStoreForTesting(null);
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] !== '--stop')
    throw new Error('Use --stop to stop the owned playtest app processes.');
  await stopStack();
}
