import { readFile } from 'node:fs/promises';

import { resolveEslintCachePath } from './eslint-cache.ts';

// Use the CLI so ESLint owns applying, regenerating, and pruning bulk suppressions.
export const main = async (args = process.argv.slice(2)): Promise<number> => {
  const project: { include: string[] } = JSON.parse(
    await readFile('config/tsconfig.eslint.json', 'utf8')
  );
  const directories = [
    ...new Set(project.include.map(pattern => pattern.replace(/^\.\.\//u, '').split('/**/')[0])),
  ];
  const child = Bun.spawn(
    [
      process.execPath,
      'node_modules/eslint/bin/eslint.js',
      '--config',
      'config/eslint.sonar.config.mjs',
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      await resolveEslintCachePath('sonar'),
      '--suppressions-location',
      'config/eslint-suppressions.json',
      ...directories,
      ...args,
    ],
    { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
  );
  return child.exited;
};

if (import.meta.main) process.exitCode = await main();
