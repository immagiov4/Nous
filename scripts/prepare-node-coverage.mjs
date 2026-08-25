import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const coverageReport = resolve(scriptDirectory, '..', 'coverage', 'lcov.info');
const pinnedVersion = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const coveragePreparation = {
  activeVersion: process.versions.node,
  coverageReport,
  pinnedVersion,
};

export function prepareNodeCoverage({
  activeVersion,
  coverageReport: reportPath,
  pinnedVersion: requiredVersion,
}) {
  rmSync(reportPath, { force: true });

  if (activeVersion === requiredVersion) {
    return true;
  }

  process.stderr.write(
    `Node ${requiredVersion} is required for coverage, but PATH resolves to ${activeVersion}.\n`
  );
  return false;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === scriptPath;

if (isEntrypoint && !prepareNodeCoverage(coveragePreparation)) {
  process.exitCode = 1;
}
