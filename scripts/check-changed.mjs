import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git failed.');
  return result.stdout;
}

function runCheck(check, files) {
  const result = spawnSync(process.execPath, [...check, ...files], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    // Split only when the OS rejects the argument list, without imposing a file-count limit.
    if (['E2BIG', 'ENAMETOOLONG'].includes(result.error.code) && files.length > 1) {
      const middle = Math.ceil(files.length / 2);
      return runCheck(check, files.slice(0, middle)) || runCheck(check, files.slice(middle));
    }
    throw result.error;
  }
  return result.status ?? 1;
}

function main() {
  // The merge base selects this branch's changes without including incoming main changes.
  const base = git('merge-base', 'origin/main', 'HEAD').trim();
  const files = [
    ...new Set([
      ...git('diff', '--name-only', '--diff-filter=ACMR', '-z', base, '--').split('\0'),
      ...git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base, '--').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ]),
  ]
    .filter(file => file && existsSync(file))
    .sort()
    .map(file => resolve(file));
  if (!files.length) {
    console.log('No changed files.');
    return 0;
  }
  const checks = [
    ['node_modules/@biomejs/biome/bin/biome', 'check', '--no-errors-on-unmatched'],
    ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.config.mjs', '--no-warn-ignored'],
    [
      'node_modules/eslint/bin/eslint.js',
      '--config',
      'eslint.sonar.config.mjs',
      '--suppressions-location',
      'eslint-suppressions.json',
      '--no-warn-ignored',
    ],
  ];
  for (const check of checks) {
    const code = runCheck(check, files);
    if (code !== 0) return code;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`check:changed: ${error.message}`);
  process.exitCode = 1;
}
