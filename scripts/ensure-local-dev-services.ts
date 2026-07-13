// Starts the local infrastructure required by the configured development environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_DEPENDENCY_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'DATABASE_URL'] as const;
const LOCAL_AUTH_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL'] as const;
const DEFAULT_LOCAL_AUTH_URL = 'http://127.0.0.1:54321';
const execFileAsync = promisify(execFile);

type Environment = Record<string, string | undefined>;

export interface LocalDevServicesRuntime {
  platform: NodeJS.Platform;
  requestHealth(url: string): Promise<boolean>;
  run(command: readonly string[]): Promise<boolean>;
  writeStatus(message: string): void;
}

const runCommand = async (command: readonly string[]): Promise<boolean> => {
  const [executable, ...args] = command;
  try {
    await execFileAsync(executable, args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

const defaultRuntime: LocalDevServicesRuntime = {
  platform: process.platform,
  run: runCommand,
  requestHealth: async url => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  },
  writeStatus: message => process.stdout.write(`${message}\n`),
};

const parseUrl = (value: string | undefined): URL | null => {
  if (!value?.trim()) {
    return null;
  }

  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
};

const isLoopbackUrl = (url: URL | null): url is URL =>
  Boolean(url && LOOPBACK_HOSTNAMES.has(url.hostname));

const getLocalUrls = (environment: Environment, keys: readonly string[]): URL[] =>
  keys.map(key => parseUrl(environment[key])).filter(isLoopbackUrl);

const ensureDocker = async (runtime: LocalDevServicesRuntime): Promise<void> => {
  if (await runtime.run(['docker', 'info'])) {
    return;
  }

  if (runtime.platform !== 'win32' && runtime.platform !== 'darwin') {
    throw new Error('Docker is not running. Start the Docker engine and run bun run dev again.');
  }

  runtime.writeStatus('[dev] Docker is not running. Starting Docker Desktop...');
  if (!(await runtime.run(['docker', 'desktop', 'start', '--timeout', '120']))) {
    throw new Error(
      'Docker Desktop could not be started. Install or start Docker Desktop, then run bun run dev again.'
    );
  }

  if (!(await runtime.run(['docker', 'info']))) {
    throw new Error(
      'Docker Desktop started, but its engine is not reachable. Open Docker Desktop and retry.'
    );
  }
};

const ensureSupabase = async (runtime: LocalDevServicesRuntime): Promise<void> => {
  if (!(await runtime.run(['bunx', 'supabase', 'status']))) {
    runtime.writeStatus('[dev] Starting local Supabase...');
    if (!(await runtime.run(['bunx', 'supabase', 'start', '--yes']))) {
      throw new Error('Local Supabase could not be started. Check Docker Desktop and retry.');
    }

    if (!(await runtime.run(['bunx', 'supabase', 'status']))) {
      throw new Error('Local Supabase started but did not become ready.');
    }
  }

  if (!(await runtime.run(['bunx', 'supabase', 'migration', 'up', '--local', '--yes']))) {
    throw new Error('Local Supabase migrations could not be applied. Check the migration output.');
  }
};

export const ensureLocalDevServices = async (
  environment: Environment = process.env,
  runtime: LocalDevServicesRuntime = defaultRuntime
): Promise<void> => {
  if (getLocalUrls(environment, LOCAL_DEPENDENCY_KEYS).length === 0) {
    return;
  }

  await ensureDocker(runtime);
  await ensureSupabase(runtime);

  const configuredAuthOrigins = getLocalUrls(environment, LOCAL_AUTH_KEYS).map(url => url.origin);
  const authOrigins = configuredAuthOrigins.length
    ? [...new Set(configuredAuthOrigins)]
    : [DEFAULT_LOCAL_AUTH_URL];
  for (const authOrigin of authOrigins) {
    if (!(await runtime.requestHealth(`${authOrigin}/auth/v1/health`))) {
      throw new Error(`Local Supabase Auth is not reachable at ${authOrigin}.`);
    }
  }

  runtime.writeStatus('[dev] Local Supabase is ready.');
};

if (import.meta.main) {
  try {
    await ensureLocalDevServices();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local development services failed.';
    process.stderr.write(`[dev] ${message}\n`);
    process.exitCode = 1;
  }
}
