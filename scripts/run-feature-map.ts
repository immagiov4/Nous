import { rm } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const observationDirectory = path.join(repoRoot, 'tmp/feature-map-observations');

await rm(observationDirectory, { force: true, recursive: true });

const testProcess = Bun.spawn(
  [
    'bun',
    '--bun',
    'vitest',
    'run',
    '--config',
    'apps/web/vitest.config.ts',
    '--no-file-parallelism',
    'scripts/feature-map.journeys.test.tsx',
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, FEATURE_MAP_OBSERVATION_DIR: observationDirectory },
    stderr: 'inherit',
    stdout: 'inherit',
  }
);
const testExitCode = await testProcess.exited;
if (testExitCode !== 0) process.exit(testExitCode);

const generationProcess = Bun.spawn(['bun', 'run', 'scripts/feature-map.ts'], {
  cwd: repoRoot,
  stderr: 'inherit',
  stdout: 'inherit',
});
const generationExitCode = await generationProcess.exited;
await rm(observationDirectory, { force: true, recursive: true });
process.exit(generationExitCode);
