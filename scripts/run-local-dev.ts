import { realpathSync } from 'node:fs';
import path from 'node:path';

const repoRoot = realpathSync(path.resolve(import.meta.dir, '..'));
const devProcess = Bun.spawn(
  ['bunx', 'concurrently', '--kill-others-on-fail', 'bun run dev:frontend', 'bun run dev:backend'],
  {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }
);

process.exitCode = await devProcess.exited;
