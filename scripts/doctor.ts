import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FALLOW_BASELINE_PATH = path.resolve('.fallow-baselines/regression.json');
const PACKAGE_MANIFEST_PATH = path.resolve('package.json');
const SONAR_LOCAL_SETTINGS_PATH = path.resolve('sonar.local.properties');
const WORKSPACE_BIN_PATH = path.resolve('node_modules/.bin');

const REQUIRED_WORKSPACE_BINARIES = [
  'biome',
  'dependency-cruiser',
  'eslint',
  'tsgo',
  'vitest',
] as const;

const DIAGNOSTIC_STAGES = [
  { label: 'Quality checks', script: 'quality' },
  { label: 'Semgrep rule tests', script: 'check:semgrep:rules' },
  { label: 'Semgrep repository scan', script: 'check:semgrep' },
  { label: 'Fallow regression check', script: 'check:fallow:ci' },
  { label: 'Test suite', script: 'test' },
] as const;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const writeResult = ({ detail, label, status }: DiagnosticResult) => {
  process.stdout.write(`[${status}] ${label}: ${detail}\n`);
};

const workspaceBinaryExists = (binaryName: string) => {
  const candidates =
    process.platform === 'win32'
      ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.ps1`, binaryName]
      : [binaryName];

  return candidates.some(candidate => existsSync(path.join(WORKSPACE_BIN_PATH, candidate)));
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

const inspectEnvironment = (): DiagnosticResult[] => {
  const currentBunVersion = process.versions.bun ?? 'unknown';
  let bunRuntimeResult: DiagnosticResult;
  try {
    const pinnedBunVersion = parsePinnedBunVersion(readFileSync(PACKAGE_MANIFEST_PATH, 'utf8'));
    bunRuntimeResult =
      currentBunVersion === pinnedBunVersion
        ? {
            detail: currentBunVersion,
            label: 'Bun runtime',
            status: 'PASS',
          }
        : {
            detail: `Expected ${pinnedBunVersion}, found ${currentBunVersion}. Run "bun upgrade".`,
            label: 'Bun runtime',
            status: 'FAIL',
          };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error';
    bunRuntimeResult = {
      detail: `Invalid packageManager in package.json: ${reason}.`,
      label: 'Bun runtime',
      status: 'FAIL',
    };
  }

  const missingWorkspaceBinaries = REQUIRED_WORKSPACE_BINARIES.filter(
    binaryName => !workspaceBinaryExists(binaryName)
  );
  const workspaceDependencyResult: DiagnosticResult =
    missingWorkspaceBinaries.length === 0
      ? {
          detail: 'Canonical quality and test executables are installed.',
          label: 'Workspace dependencies',
          status: 'PASS',
        }
      : {
          detail: `Missing ${missingWorkspaceBinaries.join(', ')}. Run "bun run deps:install".`,
          label: 'Workspace dependencies',
          status: 'FAIL',
        };

  const uvxResult: DiagnosticResult = Bun.which('uvx')
    ? {
        detail: 'Available for the pinned Semgrep checks.',
        label: 'uvx runtime',
        status: 'PASS',
      }
    : {
        detail: 'Required by the Semgrep gate. Install uv and retry.',
        label: 'uvx runtime',
        status: 'FAIL',
      };

  const sonarReadinessResult: DiagnosticResult = existsSync(SONAR_LOCAL_SETTINGS_PATH)
    ? {
        detail: 'Local settings are present; service reachability is not probed.',
        label: 'Sonar readiness',
        status: 'PASS',
      }
    : {
        detail:
          'Local settings are absent, so "bun run gate:full" cannot scan Sonar yet. ' +
          'The Doctor does not start or configure services.',
        label: 'Sonar readiness',
        status: 'WARN',
      };

  return [
    bunRuntimeResult,
    workspaceDependencyResult,
    uvxResult,
    inspectFallowBaseline(),
    sonarReadinessResult,
  ];
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

const main = async () => {
  process.stdout.write('Nous Reader Doctor\n\nEnvironment\n');
  const environmentResults = inspectEnvironment();
  for (const result of environmentResults) writeResult(result);

  process.stdout.write(
    '[WARN] Service-backed checks: Sonar analysis and Supabase contracts are intentionally not run.\n'
  );

  const failedPreflight = environmentResults.some(result => result.status === 'FAIL');
  if (failedPreflight) {
    process.stdout.write('\nChecks\n');
    for (const stage of DIAGNOSTIC_STAGES) {
      writeResult({
        detail: 'Resolve the failed environment checks first.',
        label: stage.label,
        status: 'SKIP',
      });
    }
    process.stderr.write('\nDoctor found an environment blocker.\n');
    process.exitCode = 1;
    return;
  }

  const stageResults: DiagnosticResult[] = [];
  for (const stage of DIAGNOSTIC_STAGES) {
    stageResults.push(await runDiagnosticStage(stage));
  }

  process.stdout.write('\nSummary\n');
  for (const result of stageResults) writeResult(result);

  const failedStages = stageResults.filter(result => result.status === 'FAIL');
  if (failedStages.length > 0) {
    process.stderr.write(`\nDoctor found ${failedStages.length} failing check(s).\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\nDoctor found no failures in the service-free checks.\n');
};

if (import.meta.main) await main();
