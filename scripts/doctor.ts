import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { LOCAL_SONAR_HOST_URL, LOCAL_SONAR_SYSTEM_STATUS_URL } from './sonar-local.ts';

const CI_WORKFLOW_PATH = path.resolve('.github/workflows/ci.yml');
const FALLOW_BASELINE_PATH = path.resolve('.fallow-baselines/regression.json');
const PACKAGE_MANIFEST_PATH = path.resolve('package.json');
const WORKSPACE_BIN_PATH = path.resolve('node_modules/.bin');
const REALTIME_LOCAL_TENANT = 'realtime-dev';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const CHECK_WORKSPACE_BINARIES = [
  'biome',
  'dependency-cruiser',
  'eslint',
  'tsgo',
  'vitest',
] as const;
const GATE_WORKSPACE_BINARIES = ['sonar-scanner'] as const;
const LOCAL_WORKSPACE_BINARIES = ['supabase'] as const;

const DIAGNOSTIC_STAGES = [
  { label: 'Quality checks', script: 'quality' },
  { label: 'Semgrep rule tests', script: 'check:semgrep:rules' },
  { label: 'Semgrep repository scan', script: 'check:semgrep' },
  { label: 'Fallow regression check', script: 'check:fallow:ci' },
  { label: 'Test suite', script: 'test' },
] as const;

const SUPABASE_SERVICE_CHECKS = [
  { label: 'Supabase Auth', pathName: '/auth/v1/health' },
  { label: 'Supabase Data API', pathName: '/rest/v1/' },
  { label: 'Supabase Storage', pathName: '/storage/v1/status' },
  {
    label: 'Supabase Realtime',
    pathName: `/realtime/v1/api/tenants/${REALTIME_LOCAL_TENANT}/health`,
  },
] as const;

export type DoctorProfile = 'checks' | 'gate' | 'local' | 'all';
type DiagnosticStatus = 'FAIL' | 'PASS' | 'SKIP' | 'WARN';

type DiagnosticResult = {
  detail: string;
  label: string;
  status: DiagnosticStatus;
};

type FallowCategory = {
  count: number;
  name: string;
};

export type FallowBaselineSummary = {
  categories: FallowCategory[];
  totalIssues: number;
};

export type MigrationSummary = {
  driftedMigrations: string[];
  totalMigrations: number;
};

type LocalSupabaseConfig = {
  anonKey: string;
  apiUrl: URL;
};

type EnvironmentInspectionOptions = {
  bunVersion?: string;
  findExecutable?: (command: string) => string | null;
};

export type LocalSupabaseConfigResolution =
  | { config: LocalSupabaseConfig; kind: 'ready' }
  | { cause: string; kind: 'invalid' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseDoctorArguments = (arguments_: readonly string[]): DoctorProfile => {
  let profile: DoctorProfile = 'checks';

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const profileValue = argument === '--profile' ? arguments_[index + 1] : argument.split('=')[1];
    if (argument === '--profile') index += 1;

    if (
      (argument === '--profile' || argument.startsWith('--profile=')) &&
      (profileValue === 'checks' ||
        profileValue === 'gate' ||
        profileValue === 'local' ||
        profileValue === 'all')
    ) {
      profile = profileValue;
      continue;
    }

    throw new TypeError(`Unsupported Doctor argument: ${argument}`);
  }

  return profile;
};

export const parsePinnedBunVersion = (contents: string): string => {
  const manifest = JSON.parse(contents) as unknown;
  if (!isRecord(manifest) || typeof manifest.packageManager !== 'string') {
    throw new TypeError('missing packageManager');
  }

  const match = /^bun@(.+)$/u.exec(manifest.packageManager);
  if (!match?.[1]) {
    throw new TypeError('packageManager must pin Bun');
  }

  return match[1];
};

export const parseCiBunVersions = (contents: string): string[] => {
  const versions = [...contents.matchAll(/bun-version:\s*([^\s#]+)/gu)].map(match => match[1]);
  if (versions.length === 0) {
    throw new TypeError('missing bun-version');
  }
  return [...new Set(versions)].sort((left, right) => left.localeCompare(right));
};

const compareFallowCategories = (left: FallowCategory, right: FallowCategory) => {
  const issueCountOrder = right.count - left.count;
  if (issueCountOrder !== 0) return issueCountOrder;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
};

export const parseFallowBaseline = (contents: string): FallowBaselineSummary => {
  const baseline = JSON.parse(contents) as unknown;
  if (!isRecord(baseline) || !isRecord(baseline.check)) {
    throw new TypeError('missing check object');
  }

  const issueCounts = Object.entries(baseline.check);
  for (const [name, count] of issueCounts) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new TypeError(`${name} must be a non-negative integer`);
    }
  }

  const totalIssues = baseline.check.total_issues;
  if (typeof totalIssues !== 'number') {
    throw new TypeError('missing total_issues');
  }

  const categories = issueCounts
    .filter(
      (entry): entry is [string, number] =>
        entry[0] !== 'total_issues' && typeof entry[1] === 'number' && entry[1] > 0
    )
    .map(([name, count]) => ({ count, name: name.replaceAll('_', ' ') }))
    .sort(compareFallowCategories);

  return { categories, totalIssues };
};

export const parseMigrationList = (contents: string): MigrationSummary => {
  const result = JSON.parse(contents) as unknown;
  if (!isRecord(result) || !Array.isArray(result.migrations)) {
    throw new TypeError('missing migrations');
  }

  const driftedMigrations: string[] = [];
  for (const migration of result.migrations) {
    if (!isRecord(migration)) {
      throw new TypeError('invalid migration entry');
    }
    const local = typeof migration.local === 'string' ? migration.local : '-';
    const remote = typeof migration.remote === 'string' ? migration.remote : '-';
    if (local !== remote) driftedMigrations.push(`local=${local}, database=${remote}`);
  }

  return {
    driftedMigrations,
    totalMigrations: result.migrations.length,
  };
};

const parseUrl = (value: string | undefined): URL | null => {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
};

const isLoopbackUrl = (url: URL | null): url is URL =>
  Boolean(url && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()));

export const resolveLocalSupabaseConfig = (
  environment: Record<string, string | undefined>
): LocalSupabaseConfigResolution => {
  const apiUrl = parseUrl(environment.SUPABASE_URL);
  const frontendUrl = parseUrl(environment.VITE_SUPABASE_URL);
  const anonKey = environment.VITE_SUPABASE_ANON_KEY?.trim();

  if (!apiUrl || !frontendUrl || !anonKey) {
    return {
      cause: 'SUPABASE_URL, VITE_SUPABASE_URL, or VITE_SUPABASE_ANON_KEY is missing.',
      kind: 'invalid',
    };
  }
  if (!isLoopbackUrl(apiUrl) || !isLoopbackUrl(frontendUrl)) {
    return { cause: 'The local profile only probes loopback Supabase URLs.', kind: 'invalid' };
  }
  if (apiUrl.origin !== frontendUrl.origin) {
    return { cause: 'Backend and frontend Supabase origins differ.', kind: 'invalid' };
  }

  return { config: { anonKey, apiUrl }, kind: 'ready' };
};

const writeResult = ({ detail, label, status }: DiagnosticResult) => {
  process.stdout.write(`[${status}] ${label}: ${detail}\n`);
};

const workspaceBinaryCandidates = (binaryName: string) =>
  process.platform === 'win32'
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.ps1`, binaryName]
    : [binaryName];

const workspaceBinaryPath = (binaryName: string): string | null => {
  for (const candidate of workspaceBinaryCandidates(binaryName)) {
    const candidatePath = path.join(WORKSPACE_BIN_PATH, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
};

const profileIncludesChecks = (profile: DoctorProfile) => profile === 'checks' || profile === 'all';
const profileIncludesGate = (profile: DoctorProfile) => profile === 'gate' || profile === 'all';
const profileIncludesLocal = (profile: DoctorProfile) => profile === 'local' || profile === 'all';

const requiredWorkspaceBinaries = (profile: DoctorProfile): string[] => {
  const binaries = new Set<string>();
  if (profileIncludesChecks(profile)) {
    for (const binary of CHECK_WORKSPACE_BINARIES) binaries.add(binary);
  }
  if (profileIncludesGate(profile)) {
    for (const binary of GATE_WORKSPACE_BINARIES) binaries.add(binary);
  }
  if (profileIncludesLocal(profile)) {
    for (const binary of LOCAL_WORKSPACE_BINARIES) binaries.add(binary);
  }
  return [...binaries].sort((left, right) => left.localeCompare(right));
};

const inspectBunRuntime = (
  currentBunVersion = process.versions.bun ?? 'unknown'
): DiagnosticResult => {
  try {
    const pinnedBunVersion = parsePinnedBunVersion(readFileSync(PACKAGE_MANIFEST_PATH, 'utf8'));
    const ciVersions = parseCiBunVersions(readFileSync(CI_WORKFLOW_PATH, 'utf8'));
    if (currentBunVersion !== pinnedBunVersion) {
      return {
        detail: `Expected ${pinnedBunVersion}, found ${currentBunVersion}. Run "bun upgrade".`,
        label: 'Bun runtime',
        status: 'FAIL',
      };
    }
    if (ciVersions.length !== 1 || ciVersions[0] !== pinnedBunVersion) {
      return {
        detail: `package.json pins ${pinnedBunVersion}; CI pins ${ciVersions.join(', ')}.`,
        label: 'Bun runtime',
        status: 'FAIL',
      };
    }
    return {
      detail: `${currentBunVersion} (local, package.json, and CI).`,
      label: 'Bun runtime',
      status: 'PASS',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error';
    return {
      detail: `Invalid Bun version contract: ${reason}.`,
      label: 'Bun runtime',
      status: 'FAIL',
    };
  }
};

const inspectWorkspaceDependencies = (profile: DoctorProfile): DiagnosticResult => {
  const missingBinaries = requiredWorkspaceBinaries(profile).filter(
    binaryName => !workspaceBinaryPath(binaryName)
  );
  return missingBinaries.length === 0
    ? {
        detail: 'Required project executables are installed.',
        label: 'Workspace dependencies',
        status: 'PASS',
      }
    : {
        detail: `Missing ${missingBinaries.join(', ')}. Run "bun run deps:install".`,
        label: 'Workspace dependencies',
        status: 'FAIL',
      };
};

const inspectFallowBaseline = (): DiagnosticResult => {
  try {
    const baseline = parseFallowBaseline(readFileSync(FALLOW_BASELINE_PATH, 'utf8'));
    const categorySummary = baseline.categories
      .map(category => `${category.count} ${category.name}`)
      .join(', ');
    return {
      detail:
        `${baseline.totalIssues} accepted issues` +
        (categorySummary ? ` (${categorySummary}).` : '.') +
        ' Run "bun run check:fallow" for the current candidates.',
      label: 'Fallow baseline',
      status: baseline.totalIssues > 0 ? 'WARN' : 'PASS',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error';
    return {
      detail: `Invalid ${path.relative(process.cwd(), FALLOW_BASELINE_PATH)}: ${reason}.`,
      label: 'Fallow baseline',
      status: 'FAIL',
    };
  }
};

export const inspectEnvironment = (
  profile: DoctorProfile,
  options: EnvironmentInspectionOptions = {}
): DiagnosticResult[] => {
  const results = [inspectBunRuntime(options.bunVersion), inspectWorkspaceDependencies(profile)];
  if (profileIncludesChecks(profile)) {
    const findExecutable = options.findExecutable ?? (command => Bun.which(command));
    results.push(
      findExecutable('uvx')
        ? {
            detail: 'Available for the pinned Semgrep checks.',
            label: 'uvx runtime',
            status: 'PASS',
          }
        : {
            detail: 'Required by the Semgrep gate. Install uv and retry.',
            label: 'uvx runtime',
            status: 'FAIL',
          },
      inspectFallowBaseline()
    );
  }
  return results;
};

const readJsonResponse = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body = (await response.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
};

export const inspectSonarService = async (request = fetch): Promise<DiagnosticResult> => {
  try {
    const systemResponse = await request(LOCAL_SONAR_SYSTEM_STATUS_URL);
    const system = await readJsonResponse(systemResponse);
    if (!systemResponse.ok || system.status !== 'UP') {
      const reportedStatus =
        typeof system.status === 'string' ? system.status : `HTTP ${systemResponse.status}`;
      return {
        detail: `Service returned ${reportedStatus}.`,
        label: 'SonarQube',
        status: 'FAIL',
      };
    }

    return {
      detail: `UP at ${LOCAL_SONAR_HOST_URL}; anonymous analysis is enabled.`,
      label: 'SonarQube',
      status: 'PASS',
    };
  } catch {
    return {
      detail: `Not reachable at ${LOCAL_SONAR_HOST_URL}. Start it with "bun run sonar:up".`,
      label: 'SonarQube',
      status: 'FAIL',
    };
  }
};

const inspectSupabaseServices = async (): Promise<DiagnosticResult[]> => {
  const resolution = resolveLocalSupabaseConfig(process.env);
  if (resolution.kind === 'invalid') {
    return [
      {
        detail: resolution.cause,
        label: 'Supabase configuration',
        status: 'FAIL',
      },
    ];
  }

  const results: DiagnosticResult[] = [
    {
      detail: `Local API configured at ${resolution.config.apiUrl.origin}.`,
      label: 'Supabase configuration',
      status: 'PASS',
    },
  ];
  const headers = {
    apikey: resolution.config.anonKey,
    Authorization: `Bearer ${resolution.config.anonKey}`,
  };

  for (const service of SUPABASE_SERVICE_CHECKS) {
    try {
      const response = await fetch(new URL(service.pathName, resolution.config.apiUrl), {
        headers,
      });
      results.push({
        detail: response.ok ? 'Responded successfully.' : `Returned HTTP ${response.status}.`,
        label: service.label,
        status: response.ok ? 'PASS' : 'FAIL',
      });
    } catch {
      results.push({
        detail: 'Not reachable. Inspect the existing local Supabase stack.',
        label: service.label,
        status: 'FAIL',
      });
    }
  }

  return results;
};

const runCapturedCommand = async (command: string[], environment?: Record<string, string>) => {
  const processHandle = Bun.spawn(command, {
    cwd: process.cwd(),
    env: environment ? { ...process.env, ...environment } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const inspectSupabaseMigrations = async (): Promise<DiagnosticResult> => {
  const executable = workspaceBinaryPath('supabase');
  if (!executable) {
    return {
      detail: 'Run "bun run deps:install".',
      label: 'Supabase migrations',
      status: 'FAIL',
    };
  }

  const result = await runCapturedCommand(
    [executable, 'migration', 'list', '--local', '--output-format', 'json'],
    { SUPABASE_TELEMETRY_DISABLED: '1' }
  );
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim().split(/\r?\n/u).at(-1) || 'Migration history is unavailable.';
    return { detail, label: 'Supabase migrations', status: 'FAIL' };
  }

  try {
    const summary = parseMigrationList(result.stdout);
    return summary.driftedMigrations.length === 0
      ? {
          detail: `${summary.totalMigrations} local migration(s) recorded in the database.`,
          label: 'Supabase migrations',
          status: 'PASS',
        }
      : {
          detail: `Migration drift: ${summary.driftedMigrations.join('; ')}.`,
          label: 'Supabase migrations',
          status: 'FAIL',
        };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error';
    return {
      detail: `Unreadable migration history: ${reason}.`,
      label: 'Supabase migrations',
      status: 'FAIL',
    };
  }
};

const runDiagnosticStage = async ({ label, script }: (typeof DIAGNOSTIC_STAGES)[number]) => {
  process.stdout.write(`\n=== ${label} (${script}) ===\n`);
  const processHandle = Bun.spawn([process.execPath, 'run', script], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await processHandle.exited;

  return {
    detail: exitCode === 0 ? `bun run ${script}` : `bun run ${script} exited with code ${exitCode}`,
    label,
    status: exitCode === 0 ? ('PASS' as const) : ('FAIL' as const),
  };
};

const runServiceDiagnostics = async (profile: DoctorProfile): Promise<DiagnosticResult[]> => {
  const results: DiagnosticResult[] = [];
  if (profileIncludesGate(profile)) results.push(await inspectSonarService());
  if (profileIncludesLocal(profile)) {
    results.push(...(await inspectSupabaseServices()), await inspectSupabaseMigrations());
  }
  return results;
};

const writeSkippedSections = (profile: DoctorProfile) => {
  if (!profileIncludesChecks(profile)) {
    writeResult({
      detail: 'Use the checks or all profile to execute quality and tests.',
      label: 'Code checks',
      status: 'SKIP',
    });
  }
  if (!profileIncludesGate(profile) && !profileIncludesLocal(profile)) {
    writeResult({
      detail: 'Use the gate, local, or all profile to probe existing services.',
      label: 'Service checks',
      status: 'SKIP',
    });
  }
};

const main = async () => {
  let profile: DoctorProfile;
  try {
    profile = parseDoctorArguments(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid Doctor invocation.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`Nous Reader Doctor (${profile})\n\nEnvironment\n`);
  const environmentResults = inspectEnvironment(profile);
  for (const result of environmentResults) writeResult(result);

  const failedPreflight = environmentResults.some(result => result.status === 'FAIL');
  if (failedPreflight) {
    process.stderr.write('\nDoctor found an environment blocker.\n');
    process.exitCode = 1;
    return;
  }

  const results: DiagnosticResult[] = [];
  if (profileIncludesChecks(profile)) {
    for (const stage of DIAGNOSTIC_STAGES) results.push(await runDiagnosticStage(stage));
  }
  results.push(...(await runServiceDiagnostics(profile)));

  process.stdout.write('\nSummary\n');
  writeSkippedSections(profile);
  for (const result of results) writeResult(result);

  const failedResults = results.filter(result => result.status === 'FAIL');
  if (failedResults.length > 0) {
    process.stderr.write(`\nDoctor found ${failedResults.length} failing check(s).\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\nDoctor found no failures in the selected profile.\n');
};

if (import.meta.main) await main();
