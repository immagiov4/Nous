import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { captureWorkflowDeployment } from './capture-workflow-deployment.ts';

const { connect, deployment, fixtureStatus, writeFixture } = vi.hoisted(() => {
  const boundary = {
    workflowId: 'sample',
    definitionHash: 'a'.repeat(64),
    definitionHashVersion: 1,
  };
  return {
    connect: vi.fn(),
    deployment: { current: boundary, supportedDefinitions: [boundary] },
    fixtureStatus: vi.fn(),
    writeFixture: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: fixtureStatus,
  writeFileSync: writeFixture,
}));
vi.mock('postgres', () => ({ default: connect }));
vi.mock('../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js', () => ({
  WORKFLOW_SET_VERSION: 18,
  createProductionRegistry: () => ({ listDefinitionDeployments: () => [deployment] }),
}));

const gitPath = resolve('git');
const outputPath = 'deployment.json';
const appliedVersionsPath = 'applied.txt';
const fixturesDirectory = resolve('apps/backend/tests/workflows/fixtures');

afterEach(() => vi.resetAllMocks());

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

  expect(writeFixture.mock.calls[0]?.[0]).toBe(resolve(fixturesDirectory, outputPath));
  expect(JSON.parse(writeFixture.mock.calls[0]?.[1])).toEqual({
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
  expect(writeFixture).not.toHaveBeenCalled();
});

test('requires output paths before running Git', async () => {
  await expect(captureWorkflowDeployment([], gitPath, undefined)).rejects.toThrow('manifest.json');
  expect(execFileSync).not.toHaveBeenCalled();
});

test('never writes a manifest when Git rejects the checkout', async () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('tracked changes');
  });
  await expect(
    captureWorkflowDeployment(['--local', outputPath], gitPath, undefined)
  ).rejects.toThrow('tracked changes');
  expect(writeFixture).not.toHaveBeenCalled();
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
  expect(writeFixture.mock.calls[0]?.[0]).toBe(resolve(fixturesDirectory, outputPath));
  expect(JSON.parse(writeFixture.mock.calls[0]?.[1])).toEqual({
    commit: 'revision',
    workflowSetVersion: scenario.expectedVersion,
    migrations: ['001_first.sql', '002_second.sql'],
    deployments: [persisted],
  });
  expect(writeFixture.mock.calls[1]).toEqual([
    resolve(fixturesDirectory, appliedVersionsPath),
    '001\n003\n',
  ]);
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
  expect(writeFixture).not.toHaveBeenCalled();
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
  expect(writeFixture).not.toHaveBeenCalled();
});

test('database mode requires a URL and the correct fixture extensions', async () => {
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath, '--previous'], gitPath, databaseUrl)
  ).rejects.toThrow('released-commit');
  await expect(
    captureWorkflowDeployment([outputPath, appliedVersionsPath], gitPath, undefined)
  ).rejects.toThrow('DATABASE_URL');
  await expect(
    captureWorkflowDeployment([outputPath, outputPath], gitPath, databaseUrl)
  ).rejects.toThrow('plain .txt filename');
  expect(connect).not.toHaveBeenCalled();
});

test.each([
  ['--local', '../outside.json'],
  ['--local', resolve('outside.json')],
  ['../outside.json', appliedVersionsPath],
  [resolve('outside.json'), appliedVersionsPath],
  [outputPath, '../outside.txt'],
  [outputPath, resolve('outside.txt')],
])('rejects fixture arguments that escape the directory (%s, %s)', async (...args) => {
  await expect(captureWorkflowDeployment(args, gitPath, databaseUrl)).rejects.toThrow('plain');
  expect(execFileSync).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(writeFixture).not.toHaveBeenCalled();
});

test('rejects a fixture destination linked to another file', async () => {
  fixtureStatus.mockReturnValueOnce({ isFile: () => false, nlink: 1 });
  await expect(
    captureWorkflowDeployment(['--local', outputPath], gitPath, undefined)
  ).rejects.toThrow('regular, unlinked file');
  expect(writeFixture).not.toHaveBeenCalled();
});
