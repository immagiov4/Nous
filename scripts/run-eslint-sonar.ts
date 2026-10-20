import { readFile } from 'node:fs/promises';

import { resolveEslintCachePath } from './eslint-cache.ts';

// Use the CLI so ESLint owns applying, regenerating, and pruning bulk suppressions.
if (import.meta.main) {
  const project: { include: string[] } = JSON.parse(await readFile('tsconfig.eslint.json', 'utf8'));
  const directories = [...new Set(project.include.map(pattern => pattern.split('/**/')[0]))];
  const child = Bun.spawn(
    [
      process.execPath,
      'node_modules/eslint/bin/eslint.js',
      '--config',
      'eslint.sonar.config.mjs',
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      await resolveEslintCachePath('sonar'),
      '--suppressions-location',
      'eslint-suppressions.json',
      ...directories,
      ...process.argv.slice(2),
    ],
    { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
  );
  process.exitCode = await child.exited;
}
