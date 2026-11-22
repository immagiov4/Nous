import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureWorkflowDeployment } from './capture-workflow-deployment.ts';

const { deployment } = vi.hoisted(() => {
  const boundary = {
    workflowId: 'sample',
    definitionHash: 'a'.repeat(64),
    definitionHashVersion: 1,
  };
  return { deployment: { current: boundary, supportedDefinitions: [boundary] } };
});

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js', () => ({
  WORKFLOW_SET_VERSION: 18,
  createProductionRegistry: () => ({ listDefinitionDeployments: () => [deployment] }),
}));

const gitPath = resolve('git');
let directory: string;
let outputPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nous-deployment-capture-'));
  outputPath = join(directory, 'deployment.json');
});

afterEach(() => {
  rmSync(outputPath, { force: true });
  rmdirSync(directory);
  vi.resetAllMocks();
});

test('captures the checked-out revision, SQL migrations and production registry', () => {
  const git = vi.mocked(execFileSync);
  git
    .mockReturnValueOnce('')
    .mockReturnValueOnce('revision\n')
    .mockReturnValueOnce(
      'supabase/migrations/001_first.sql\r\nsupabase/migrations/README.md\r\nsupabase/migrations/002_second.sql\r\n'
    );

  captureWorkflowDeployment(outputPath, gitPath);

  expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
    commit: 'revision',
    workflowSetVersion: 18,
    migrations: ['001_first.sql', '002_second.sql'],
    deployments: [deployment],
  });
  expect(git.mock.calls.map(([executable]) => executable)).toEqual([gitPath, gitPath, gitPath]);
});

test.each([null, 'git'])('rejects an unavailable or relative Git path (%s)', executable => {
  expect(() => captureWorkflowDeployment(outputPath, executable)).toThrow(
    'absolute Git executable'
  );
  expect(execFileSync).not.toHaveBeenCalled();
  expect(existsSync(outputPath)).toBe(false);
});

test('requires an output path before running Git', () => {
  expect(() => captureWorkflowDeployment(undefined, gitPath)).toThrow('output path');
  expect(execFileSync).not.toHaveBeenCalled();
});

test('never writes a manifest when Git rejects the checkout', () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('tracked changes');
  });
  expect(() => captureWorkflowDeployment(outputPath, gitPath)).toThrow('tracked changes');
  expect(existsSync(outputPath)).toBe(false);
});
