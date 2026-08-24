import { readFileSync } from 'node:fs';

const pinnedVersion = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const activeVersion = process.versions.node;

if (activeVersion !== pinnedVersion) {
  process.stderr.write(
    `Node ${pinnedVersion} is required for coverage, but PATH resolves to ${activeVersion}.\n`
  );
  process.exitCode = 1;
}
