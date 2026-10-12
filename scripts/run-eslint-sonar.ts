import { resolveEslintCachePath } from './eslint-cache.ts';

// Use the CLI so ESLint owns applying, regenerating, and pruning bulk suppressions.
if (import.meta.main) {
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
      'apps/web',
      'apps/backend/src',
      'packages',
      'scripts',
      'e2e',
      ...process.argv.slice(2),
    ],
    { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
  );
  process.exitCode = await child.exited;
}
