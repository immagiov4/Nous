import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nous-rollback-'));
  writeFileSync(join(directory, 'deploy.env'), 'SUPABASE_DEPLOYMENT=managed\n');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function checkRollback(candidate: number, activated: string) {
  const env = {
    ...process.env,
    NOUS_ENV_FILE: join(directory, 'deploy.env'),
    TEST_CANDIDATE: String(candidate),
    TEST_ACTIVATED: activated,
  };
  if (process.platform === 'win32') {
    const script = `
function docker {
  $global:LASTEXITCODE = 0
  if ($args -contains '--short') { '2.24.0' }
  if ($args -contains 'db-tools') { $env:TEST_ACTIVATED }
}
function git {
  $global:LASTEXITCODE = 0
  if ($args -contains 'show') { "export const WORKFLOW_SET_VERSION = $env:TEST_CANDIDATE;" }
  elseif ($args -contains 'switch') { 'release switched' }
  else { '0000000000000000000000000000000000000001' }
}
& ./deploy/nous.ps1 redeploy v-candidate
`;
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env,
      encoding: 'utf8',
    });
  }
  const doubles = {
    docker: `#!/bin/sh
case " $* " in
  *" --short "*) echo 2.24.0 ;;
  *" db-tools "*) printf '%s\\n' "$TEST_ACTIVATED" ;;
esac
`,
    git: `#!/bin/sh
case " $* " in
  *" show "*) printf 'export const WORKFLOW_SET_VERSION = %s;\\n' "$TEST_CANDIDATE" ;;
  *" switch "*) echo 'release switched' ;;
  *) echo 0000000000000000000000000000000000000001 ;;
esac
`,
  };
  for (const [command, content] of Object.entries(doubles)) {
    const path = join(directory, command);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  return spawnSync('sh', ['deploy/nous.sh', 'redeploy', 'v-candidate'], {
    env: { ...env, PATH: directory + delimiter + process.env.PATH },
    encoding: 'utf8',
  });
}

test('the deployed rollback check accepts a release that supports the active workflow version', () => {
  const result = checkRollback(19, '19');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Workflow set 19 supports active version 19');
  expect(result.stdout).toContain('release switched');
});

test('the deployed rollback check blocks a release older than the active workflow version', () => {
  const result = checkRollback(18, '19');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('Workflow set 18 is older than active version 19');
  expect(result.stdout).not.toContain('release switched');
});

test('the deployed rollback check fails closed when the active workflow version is unavailable', () => {
  const result = checkRollback(18, '');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('Cannot determine the active workflow-set version');
  expect(result.stdout).not.toContain('release switched');
});
