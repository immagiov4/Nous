import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureWorkflowDeployment } from './capture-workflow-deployment.ts';

const { connect, deployment } = vi.hoisted(() => {
  const boundary = {
    workflowId: 'sample',
    definitionHash: 'a'.repeat(64),
    definitionHashVersion: 1,
  };
  return { connect: vi.fn(), deployment: { current: boundary, supportedDefinitions: [boundary] } };
});

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('postgres', () => ({ default: connect }));
vi.mock('../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js', () => ({
  WORKFLOW_SET_VERSION: 18,
  createProductionRegistry: () => ({ listDefinitionDeployments: () => [deployment] }),
}));

const gitPath = resolve('git');
let directory: string;
let outputPath: string;
let appliedVersionsPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nous-deployment-capture-'));
  outputPath = join(directory, 'deployment.json');
  appliedVersionsPath = join(directory, 'applied.txt');
});

afterEach(() => {
  rmSync(outputPath, { force: true });
  rmSync(appliedVersionsPath, { force: true });
  rmdirSync(directory);
  vi.resetAllMocks();
});

function mockCheckout() {
  const git = vi.mocked(execFileSync);
  git
    .mockReturnValueOnce('')
    .mockReturnValueOnce('revision\n')
    .mockReturnValueOnce(
      'supabase/migrations/001_first.sql\r\nsupabase/migrations/README.md\r\nsupabase/migrations/002_second.sql\r\n'
    );

  return git;
}

test('local fallback captures the checkout and computed registry', async () => {
  const git = mockCheckout();
  await captureWorkflowDeployment(['--local', outputPath], gitPath, undefined);

  expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
    commit: 'revision',
    workflowSetVersion: 18,
    migrations: ['001_first.sql', '002_second.sql'],
    deployments: [deployment],
  });
  expect(git.mock.calls.map(([executable]) => executable)).toEqual([gitPath, gitPath, gitPath]);
  expect(connect).not.toHaveBeenCalled();
});

test.each([null, 'git'])('rejects an unavailable or relative Git path (%s)', async executable => {
  await expect(
    captureWorkflowDeployment(['--local', outputPath], executable, undefined)
  ).rejects.toThrow('absolute Git executable');
  expect(execFileSync).not.toHaveBeenCalled();
  expect(existsSync(outputPath)).toBe(false);
});

test('requires output paths before running Git', async () => {
  await expect(captureWorkflowDeployment([], gitPath, undefined)).rejects.toThrow('manifest-path');
  expect(execFileSync).not.toHaveBeenCalled();
});

test('never writes a manifest when Git rejects the checkout', async () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('tracked changes');
  });
  await expect(
    captureWorkflowDeployment(['--local', outputPath], gitPath, undefined)
  ).rejects.toThrow('tracked changes');
  expect(existsSync(outputPath)).toBe(false);
});

const databaseUrl = 'postgresql://127.0.0.1/nous';
const persistedBoundary = { ...deployment.current, definitionHash: 'b'.repeat(64) };
const persisted = { current: persistedBoundary, supportedDefinitions: [persistedBoundary] };

function mockDatabase(registry: unknown) {
  const transaction = vi
    .fn()
    .mockResolvedValueOnce([registry])
    .mockResolvedValueOnce([{ version: '001' }, { version: '003' }]);
  const begin = vi.fn(
    async (_mode: string, read: (query: typeof transaction) => Promise<unknown>) =>
      read(transaction)
  );
  const end = vi.fn();
  connect.mockReturnValue({ begin, end });
  return { begin, end };
}

test.each([
  {
    selector: [],
    currentVersion: '18',
    previousVersion: '17',
    expectedVersion: 18,
    revision: 'HEAD',
    current: [persisted],
    previous: [deployment],
  },
  {
    selector: ['--previous', '826dee5'],
    currentVersion: '19',
    previousVersion: '17',
    expectedVersion: 17,
    revision: '826dee5',
    current: [deployment],
    previous: [persisted],
  },
])('exports the persisted registry and applied versions for $selector', async scenario => {
  const git = mockCheckout();
  const { begin, end } = mockDatabase({
    current_version: scenario.currentVersion,
    current_manifest: scenario.current,
    previous_version: scenario.previousVersion,
    previous_manifest: scenario.previous,
  });

  await captureWorkflowDeployment(
    [outputPath, appliedVersionsPath, ...scenario.selector],
    gitPath,
    databaseUrl
  );

  expect(begin.mock.calls[0]?.[0]).toBe('isolation level repeatable read read only');
  expect(git.mock.calls[1]?.[1]).toEqual([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${scenario.revision}^{commit}`,
  ]);
  expect(end).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
    commit: 'revision',
    workflowSetVersion: scenario.expectedVersion,
    migrations: ['001_first.sql', '002_second.sql'],
    deployments: [persisted],
  });
  expect(readFileSync(appliedVersionsPath, 'utf8')).toBe('001\n003\n');
});

test.each([
  { version: null, expected: 'absent' },
  { version: '0', expected: 'version is invalid' },
  { version: '19', expected: 'deployed commit' },
])('rejects an absent or mismatched persisted version ($version)', async ({
  version,
  expected,
}) => {
  mockCheckout();
  mockDatabase({ current_version: version, current_manifest: [persisted] });
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath], gitPath, databaseUrl)
  ).rejects.toThrow(expected);
  expect(existsSync(outputPath)).toBe(false);
  expect(existsSync(appliedVersionsPath)).toBe(false);
});

test('database export errors omit credentials', async () => {
  mockCheckout();
  connect.mockImplementationOnce(() => {
    throw new Error('synthetic-url-password');
  });
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath], gitPath, databaseUrl)
  ).rejects.toThrow(
    /^Could not export deployment history\. Check DATABASE_URL and read permissions\.$/u
  );
  expect(existsSync(outputPath)).toBe(false);
});

test('database mode requires a URL and distinct output paths', async () => {
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath, '--previous'], gitPath, databaseUrl)
  ).rejects.toThrow('released-commit');
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath], gitPath, undefined)
  ).rejects.toThrow('DATABASE_URL');
  await expect(
    captureWorkflowDeployment([outputPath, outputPath], gitPath, databaseUrl)
  ).rejects.toThrow('different output paths');
  expect(connect).not.toHaveBeenCalled();
});
