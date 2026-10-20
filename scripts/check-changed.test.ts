import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { main } from './check-changed.mjs';

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nous-changed-check-'));
  directories.push(directory);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, windowsHide: true, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  for (const file of ['committed.ts', 'staged.ts', 'working.ts', 'deleted.ts', 'renamed.ts']) {
    writeFileSync(join(directory, file), 'baseline');
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'baseline');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(resolve('scripts/check-changed.mjs'), join(directory, 'scripts/check-changed.mjs'));
  const reporter = `import { appendFileSync } from 'node:fs';
    appendFileSync('observed.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
    process.exitCode = Number(process.env.FIXTURE_EXIT || 0);`;
  for (const file of [
    'node_modules/@biomejs/biome/bin/biome',
    'node_modules/eslint/bin/eslint.js',
  ]) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), reporter);
  }
  writeFileSync(join(directory, '.gitignore'), 'node_modules/\nscripts/\nobserved.jsonl\n');
  git('add', '.gitignore');
  git('commit', '--quiet', '-m', 'fixture ignores');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = (environment = {}) =>
    spawnSync(process.execPath, ['scripts/check-changed.mjs'], {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
    });
  return { directory, git, run };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('the measured entry checks real branch files and preserves failure codes', () => {
  const { directory, git } = fixture();
  expect(main(directory)).toBe(0);
  writeFileSync(join(directory, 'working.ts'), 'branch change');
  git('add', 'working.ts');
  expect(main(directory)).toBe(0);
  const calls = readFileSync(join(directory, 'observed.jsonl'), 'utf8').trim().split('\n');
  expect(calls).toHaveLength(3);
  vi.stubEnv('FIXTURE_EXIT', '7');
  expect(main(directory)).toBe(7);
  rmSync(join(directory, '.git'), { recursive: true });
  expect(() => main(directory)).toThrow('not a git repository');
  vi.stubEnv('PATH', '');
  expect(() => main(directory)).toThrow();
});

test('checks committed, staged, working and untracked files against the branch base', () => {
  const { directory, git, run } = fixture();
  writeFileSync(join(directory, 'committed.ts'), 'committed change');
  git('add', 'committed.ts');
  git('commit', '--quiet', '-m', 'branch change');
  writeFileSync(join(directory, 'staged.ts'), 'staged change');
  git('add', 'staged.ts');
  writeFileSync(join(directory, 'staged.ts'), 'baseline');
  writeFileSync(join(directory, 'working.ts'), 'working change');
  writeFileSync(join(directory, 'new file.ts'), 'untracked');
  rmSync(join(directory, 'deleted.ts'));
  git('mv', 'renamed.ts', 'renamed file.ts');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const calls: string[][] = readFileSync(join(directory, 'observed.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(calls).toHaveLength(3);
  const expected = [
    'committed.ts',
    'new file.ts',
    'renamed file.ts',
    'staged.ts',
    'working.ts',
  ].map(file => join(directory, file));
  for (const call of calls) expect(call.slice(-expected.length)).toEqual(expected);
  expect(calls[0]).toContain('check');
  expect(calls[1]).toContain('eslint.config.mjs');
  expect(calls[2]).toContain('eslint.sonar.config.mjs');
});

test('a clean branch skips the linters', () => {
  const { run } = fixture();
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('No changed files');
});

test('a failed check fails the command', () => {
  const { directory, run } = fixture();
  writeFileSync(join(directory, 'working.ts'), 'change');
  expect(run({ FIXTURE_EXIT: '7' }).status).toBe(7);
});

test('checks every file when the path list exceeds the Windows command-line capacity', () => {
  const { directory, run } = fixture();
  const files = Array.from({ length: 400 }, (_, index) =>
    join(directory, `${String(index).padStart(4, '0')}-${'long-file-name-'.repeat(8)}.ts`)
  );
  for (const file of files) writeFileSync(file, 'change');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const calls: string[][] = readFileSync(join(directory, 'observed.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(main(directory)).toBe(0);
  if (process.platform === 'win32') expect(calls.length).toBeGreaterThan(3);
  for (const marker of ['check', 'eslint.config.mjs', 'eslint.sonar.config.mjs']) {
    expect(
      calls
        .filter(call => call.includes(marker))
        .flatMap(call => call.filter(argument => argument.startsWith(directory)))
    ).toEqual(files);
  }
});
