import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const bash =
  process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
    : 'bash';
const script = join(import.meta.dirname, 'prepare-production-baseline.sh').replaceAll('\\', '/');
let directory: string;

function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nous-production-baseline-'));
  mkdirSync(join(directory, 'bin'));
  writeFileSync(join(directory, 'github-env'), '');
  writeFileSync(
    join(directory, 'bin', 'curl'),
    '#!/bin/sh\n[ "$MOCK_HEALTH" != offline ] || exit 7\nprintf "%s" "$MOCK_HEALTH"\n',
    { mode: 0o755 }
  );
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function prepare(health: string) {
  const shellPath = directory.replaceAll('\\', '/');
  return spawnSync(
    bash,
    ['-c', 'export PATH="$(cd "$RUNNER_TEMP/bin" && pwd):$PATH"; exec bash "$SCRIPT"'],
    {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        SCRIPT: script,
        RUNNER_TEMP: shellPath,
        GITHUB_ENV: `${shellPath}/github-env`,
        MOCK_HEALTH: health,
      },
    }
  );
}

test('captures the reported production checkout and leaves the candidate checked out', () => {
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Production baseline fixture');
  git('config', 'user.email', 'baseline@example.invalid');
  const fixtures = 'apps/backend/tests/workflows/fixtures';
  mkdirSync(join(directory, fixtures), { recursive: true });
  writeFileSync(join(directory, fixtures, '.gitkeep'), '');
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ scripts: { 'workflow:capture-deployment': 'bun capture.mjs' } })
  );
  writeFileSync(
    join(directory, 'capture.mjs'),
    `import { execFileSync } from 'node:child_process';
     const [mode, output] = process.argv.slice(2);
     if (mode !== '--local') throw new Error('Expected local capture');
     const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
     await Bun.write('${fixtures}/' + output, JSON.stringify({ commit }));`
  );
  git('add', 'package.json', 'capture.mjs', fixtures);
  git('commit', '-m', 'Deployable checkout');
  const deployed = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', deployed);
  git('commit', '--allow-empty', '-m', 'Candidate checkout');
  const candidate = git('rev-parse', 'HEAD');

  const result = prepare(JSON.stringify({ status: 'ok', commit: deployed }));

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(deployed);
  const env = readFileSync(join(directory, 'github-env'), 'utf8').trim();
  expect(env).toMatch(/^NOUS_PRODUCTION_BASELINE=/u);
  const baseline = env.slice('NOUS_PRODUCTION_BASELINE='.length);
  expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual({ commit: deployed });
  expect(git('rev-parse', 'HEAD')).toBe(candidate);
  expect(git('worktree', 'list', '--porcelain')).not.toContain(`HEAD ${deployed}`);
});

test.each([
  'offline',
  '{"status":"ok"}',
  '{"commit":"invalid"}',
])('warns and keeps the committed fallback for %s', health => {
  const result = prepare(health);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('::warning::');
  expect(readFileSync(join(directory, 'github-env'), 'utf8')).toBe('');
});
