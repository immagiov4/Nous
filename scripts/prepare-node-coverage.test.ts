import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { prepareNodeCoverage } from './prepare-node-coverage.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  );
});

async function createStaleCoverageReport(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nous-node-coverage-'));
  const reportPath = join(directory, 'lcov.info');
  temporaryDirectories.push(directory);
  await writeFile(reportPath, 'stale coverage');
  return reportPath;
}

describe('prepareNodeCoverage', () => {
  test('removes stale coverage and accepts the pinned runtime', async () => {
    const reportPath = await createStaleCoverageReport();
    const writeError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      prepareNodeCoverage({
        activeVersion: '24.19.0',
        coverageReport: reportPath,
        pinnedVersion: '24.19.0',
      })
    ).toBe(true);
    await expect(access(reportPath)).rejects.toThrow();
    expect(writeError).not.toHaveBeenCalled();
  });

  test('removes stale coverage and reports a runtime mismatch', async () => {
    const reportPath = await createStaleCoverageReport();
    const writeError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      prepareNodeCoverage({
        activeVersion: '18.20.8',
        coverageReport: reportPath,
        pinnedVersion: '24.19.0',
      })
    ).toBe(false);
    await expect(access(reportPath)).rejects.toThrow();
    expect(writeError).toHaveBeenCalledWith(
      'Node 24.19.0 is required for coverage, but PATH resolves to 18.20.8.\n'
    );
  });
});
