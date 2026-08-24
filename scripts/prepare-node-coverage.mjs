import { readFileSync, rmSync } from 'node:fs';

const coverageReport = new URL('../coverage/lcov.info', import.meta.url);
const pinnedVersion = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const activeVersion = process.versions.node;

rmSync(coverageReport, { force: true });

if (activeVersion !== pinnedVersion) {
  process.stderr.write(
    `Node ${pinnedVersion} is required for coverage, but PATH resolves to ${activeVersion}.\n`
  );
  process.exitCode = 1;
}
