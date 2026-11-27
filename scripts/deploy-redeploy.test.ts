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
  *" build "*)
    [ "$NOUS_RELEASE_COMMIT" = "$(git rev-parse HEAD)" ] && [ -n "$NOUS_RELEASE_COMMIT" ] || exit 97
    echo build >> "$TEST_DIRECTORY/calls" ;;
  *" run "*" migrate "*)
    echo migrate >> "$TEST_DIRECTORY/calls"
    if [ "$TEST_REJECT" = migrate ]; then
      echo 'Remote migration versions not found in local migrations directory: 20260728120000' >&2
      exit 1
    elif [ "$TEST_REJECT" = migration-network ]; then
      echo 'Failed to connect to Postgres: connection refused' >&2
      exit 1
    fi ;;
  *" run "*" --release-check "*)
    echo candidate >> "$TEST_DIRECTORY/calls"
    case " $* " in
      *" --no-deps "*" TMPDIR=/tmp backend timeout "*" bun run apps/backend/src/server.ts --release-check "*)
        if [ "$TEST_REJECT" = candidate ]; then
          echo '{"action":"conflict","workflowId":"lesson-artifact-draft","supportedDefinitionCount":35}' >&2
          exit 65
        elif [ "$TEST_REJECT" = candidate-timeout ]; then
          exit 137
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

function scheduledDeploymentFixture() {
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
  exit 65
elif [ "$TEST_REJECT" = network ]; then
  echo 'Image registry connection lost' >&2
  exit 1
fi
`
  );
  git(upstream, 'add', 'deploy/nous.sh');
  git(upstream, 'commit', '-m', 'Healthy release');
  git(directory, 'clone', upstream, checkout);
  const deployed = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'deployed-sha'), `${deployed}\n`);
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

  const publish = () => {
    git(upstream, 'commit', '--allow-empty', '-m', 'Candidate release');
    return git(upstream, 'rev-parse', 'HEAD');
  };
  return { deployed, publish, scheduledRun, state };
}

test('the scheduled job skips a rejected SHA at once and deploys a later main revision', () => {
  const { deployed, publish, scheduledRun, state } = scheduledDeploymentFixture();
  const failed = publish();
  const rejected = scheduledRun('candidate');
  expect(rejected.status, rejected.stderr).toBe(65);
  expect(rejected.stderr).toContain('lesson-artifact-draft');
  expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(deployed);
  expect(readFileSync(join(state, 'failed-sha'), 'utf8').trim()).toBe(failed);

  const repeated = scheduledRun();
  expect(repeated.status, repeated.stderr).toBe(0);
  expect(repeated.stdout).toContain(failed);
  expect(calls()).toEqual(['redeploy']);

  const updated = publish();
  const healthy = scheduledRun();
  expect(healthy.status, healthy.stderr).toBe(0);
  expect(calls()).toEqual(['redeploy', 'redeploy']);
  expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(updated);
});

test('the scheduled job retries operational failures, skips after three, and resets for a new SHA', () => {
  const { deployed, publish, scheduledRun, state } = scheduledDeploymentFixture();
  const failed = publish();
  for (const attempt of [1, 2, 3]) {
    const result = scheduledRun('network');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(`attempt ${attempt}/3`);
    expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(deployed);
  }
  expect(readFileSync(join(state, 'failed-sha'), 'utf8').trim()).toBe(failed);
  expect(scheduledRun().stdout).toContain(`Skipping failed revision ${failed}`);
  expect(calls()).toEqual(['redeploy', 'redeploy', 'redeploy']);

  const updated = publish();
  const retry = scheduledRun('network');
  expect(retry.status, retry.stderr).toBe(1);
  expect(retry.stdout).toContain('attempt 1/3');
  expect(scheduledRun().status).toBe(0);
  expect(readFileSync(join(state, 'deployed-sha'), 'utf8').trim()).toBe(updated);
});

test('a rejected candidate leaves the live services alone', () => {
  const rejected = redeploy('candidate');
  expect(rejected.status, rejected.stderr).toBe(65);
  expect(rejected.stderr).toContain('lesson-artifact-draft');
  expect(calls()).toEqual(['build', 'migrate', 'candidate']);
});

test('a healthy candidate is checked before cutover and the public-service smoke checks', () => {
  const healthy = redeploy();
  expect(healthy.status, healthy.stderr).toBe(0);
  expect(calls()).toEqual(['build', 'migrate', 'candidate', 'backend', 'frontend', 'smoke']);
});

test.skipIf(!isWindows).each(['setup', 'redeploy'])(
  'PowerShell %s builds with the checked-out commit',
  command => {
    writeFileSync(
      join(directory, 'docker.ps1'),
      `if ($args -contains '--short') { '2.24.0' }
if ($args -contains 'build' -or $args -contains '--build') {
  Add-Content -LiteralPath (Join-Path $env:TEST_DIRECTORY 'calls') -Value $env:NOUS_RELEASE_COMMIT
}
exit 0
`
    );
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'deploy/nous.ps1', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${directory};${process.env.PATH}`,
          NOUS_ENV_FILE: join(directory, 'deploy.env'),
          NOUS_RELEASE_COMMIT: 'stale',
          TEST_DIRECTORY: directory,
        },
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual([git('.', 'rev-parse', 'HEAD')]);
  }
);

test('missing applied migration history prevents both candidate startup and cutover', () => {
  const missingBridge = redeploy('migrate');
  expect(missingBridge.status, missingBridge.stderr).toBe(65);
  expect(missingBridge.stderr).toContain('20260728120000');
  expect(calls()).toEqual(['build', 'migrate']);
});

test('database unavailability during migration remains an operational failure', () => {
  const unavailable = redeploy('migration-network');
  expect(unavailable.status, unavailable.stderr).toBe(1);
  expect(unavailable.stderr).toContain('connection refused');
  expect(calls()).toEqual(['build', 'migrate']);
});

test('a timed-out candidate keeps its operational status and leaves live services alone', () => {
  const timedOut = redeploy('candidate-timeout');
  expect(timedOut.status, timedOut.stderr).toBe(137);
  expect(calls()).toEqual(['build', 'migrate', 'candidate']);
});
