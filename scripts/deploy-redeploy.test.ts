import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const isWindows = process.platform === 'win32';
const shell = isWindows
  ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
  : 'sh';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nous-redeploy-'));
  writeFileSync(join(directory, 'deploy.env'), 'SUPABASE_DEPLOYMENT=managed\n');
  writeFileSync(join(directory, 'calls'), '');
  const doubles = {
    uname: `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
esac
`,
    docker: `#!/bin/sh
case " $* " in
  *" --short "*) echo 2.24.0 ;;
  *" build "*) echo build >> "$TEST_DIRECTORY/calls" ;;
  *" run "*" migrate "*)
    echo migrate >> "$TEST_DIRECTORY/calls"
    if [ "$TEST_REJECT" = migrate ]; then
      echo 'Remote migration versions not found in local migrations directory: 20260728120000' >&2
      exit 1
    fi ;;
  *" run "*" --release-check "*)
    echo candidate >> "$TEST_DIRECTORY/calls"
    case " $* " in
      *" --no-deps "*" TMPDIR=/tmp backend timeout "*" bun run apps/backend/src/server.ts --release-check "*)
        if [ "$TEST_REJECT" = candidate ]; then
          echo '{"action":"conflict","workflowId":"lesson-artifact-draft","supportedDefinitionCount":35}' >&2
          exit 23
        fi ;;
      *) exit 99 ;;
    esac ;;
  *" up "*" --no-deps "*" backend "*) echo backend >> "$TEST_DIRECTORY/calls" ;;
  *" up "*" --no-deps "*" frontend "*) echo frontend >> "$TEST_DIRECTORY/calls" ;;
  *" run "*" --no-deps smoke "*) echo smoke >> "$TEST_DIRECTORY/calls" ;;
  *" up "*|*" run "*" smoke "*)
    printf 'Unexpected cutover or smoke command: %s\n' "$*" >&2
    exit 98 ;;
  *" db-tools "*) ;;
esac
`,
  };
  for (const [command, script] of Object.entries(doubles)) {
    writeFileSync(join(directory, command), script, { mode: 0o755 });
  }
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function redeploy(reject = '') {
  return spawnSync(
    shell,
    [
      '-c',
      'PATH="$(cd "$TEST_DIRECTORY" && pwd):$PATH"; export PATH; exec sh deploy/nous.sh redeploy',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        NOUS_ENV_FILE: join(directory, 'deploy.env').replaceAll('\\', '/'),
        TEST_DIRECTORY: directory.replaceAll('\\', '/'),
        TEST_REJECT: reject,
      },
    }
  );
}

const calls = () => readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n');

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

test('the scheduled job records a failed SHA, skips it, and deploys a later main revision', () => {
  const upstream = join(directory, 'upstream');
  const checkout = join(directory, 'checkout');
  const state = join(directory, 'state');
  mkdirSync(join(upstream, 'deploy'), { recursive: true });
  mkdirSync(state);
  git(upstream, 'init', '--initial-branch=main');
  git(upstream, 'config', 'user.name', 'Deploy fixture');
  git(upstream, 'config', 'user.email', 'deploy-fixture@example.invalid');
  writeFileSync(
    join(upstream, 'deploy', 'nous.sh'),
    `#!/bin/sh
echo redeploy >> "$TEST_DIRECTORY/calls"
if [ "$TEST_REJECT" = candidate ]; then
  echo 'Workflow definition conflict: lesson-artifact-draft' >&2
  exit 23
fi
`
  );
  git(upstream, 'add', 'deploy/nous.sh');
  git(upstream, 'commit', '-m', 'Healthy release');
  git(directory, 'clone', upstream, checkout);
  const deployed = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'deployed-sha'), `${deployed}\n`);
  git(upstream, 'commit', '--allow-empty', '-m', 'Incompatible release');
  const failed = git(upstream, 'rev-parse', 'HEAD');
  if (isWindows) writeFileSync(join(directory, 'flock'), '#!/bin/sh\nexit 0\n');

  const scheduledRun = (reject = '') =>
    spawnSync(
      shell,
      [
        '-c',
        'DEPLOY_PATH="$(cd "$TEST_DIRECTORY" && pwd):$PATH"; export DEPLOY_PATH; exec bash "$TEST_JOB"',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          REPO: checkout.replaceAll('\\', '/'),
          STATE_DIR: state.replaceAll('\\', '/'),
          TEST_DIRECTORY: directory.replaceAll('\\', '/'),
          TEST_JOB: resolve('deploy/host/nous-deploy-pull.sh').replaceAll('\\', '/'),
          TEST_REJECT: reject,
        },
      }
    );

  const rejected = scheduledRun('candidate');
  expect(rejected.status, rejected.stderr).toBe(23);
  expect(rejected.stderr).toContain('lesson-artifact-draft');
  expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(deployed);
  expect(readFileSync(join(state, 'failed-sha'), 'utf8').trim()).toBe(failed);

  const repeated = scheduledRun();
  expect(repeated.status, repeated.stderr).toBe(0);
  expect(repeated.stdout).toContain(failed);
  expect(calls()).toEqual(['redeploy']);

  git(upstream, 'commit', '--allow-empty', '-m', 'Compatible release');
  const healthy = scheduledRun();
  expect(healthy.status, healthy.stderr).toBe(0);
  expect(calls()).toEqual(['redeploy', 'redeploy']);
  expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(
    git(upstream, 'rev-parse', 'HEAD')
  );
});

test('a rejected candidate leaves the live services alone', () => {
  const rejected = redeploy('candidate');
  expect(rejected.status, rejected.stderr).toBe(23);
  expect(rejected.stderr).toContain('lesson-artifact-draft');
  expect(calls()).toEqual(['build', 'migrate', 'candidate']);
});

test('a healthy candidate is checked before cutover and the public-service smoke checks', () => {
  const healthy = redeploy();
  expect(healthy.status, healthy.stderr).toBe(0);
  expect(calls()).toEqual(['build', 'migrate', 'candidate', 'backend', 'frontend', 'smoke']);
});

test('missing applied migration history prevents both candidate startup and cutover', () => {
  const missingBridge = redeploy('migrate');
  expect(missingBridge.status, missingBridge.stderr).toBe(1);
  expect(missingBridge.stderr).toContain('20260728120000');
  expect(calls()).toEqual(['build', 'migrate']);
});
