import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const coverageReport = resolve(scriptDirectory, '..', 'coverage', 'lcov.info');
const pinnedMajor = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const coveragePreparation = {
  activeVersion: process.versions.node,
  coverageReport,
  pinnedMajor,
};

export function prepareNodeCoverage({
  activeVersion,
  coverageReport: reportPath,
  pinnedMajor: requiredMajor,
}) {
  rmSync(reportPath, { force: true });

  // Coverage totals are identical across Node majors, so only the major is pinned.
  if (activeVersion.split('.')[0] === requiredMajor) {
    return true;
  }

  process.stderr.write(
    `Node ${requiredMajor}.x is required for coverage, but PATH resolves to ${activeVersion}.\n`
  );
  return false;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === scriptPath;

if (isEntrypoint && !prepareNodeCoverage(coveragePreparation)) {
  process.exitCode = 1;
}
