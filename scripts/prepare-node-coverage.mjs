import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const coverageReport = resolve(scriptDirectory, '..', 'coverage', 'lcov.info');
const pinnedVersion = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const activeVersion = process.versions.node;

rmSync(coverageReport, { force: true });

if (activeVersion !== pinnedVersion) {
  process.stderr.write(
    `Node ${pinnedVersion} is required for coverage, but PATH resolves to ${activeVersion}.\n`
  );
  process.exitCode = 1;
}
