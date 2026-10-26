import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { processRunning } from './heavy-run-process.mjs';

const processes: ChildProcess[] = [];
const fixturePids: number[] = [];
const directories: string[] = [];
const wrapper = resolve('scripts/heavy-run.mjs');
const FIXTURE_DEADLINE_MS = 8000;

afterEach(async () => {
  for (const pid of [...processes.map(child => child.pid), ...fixturePids]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  processes.length = 0;
  await until(() => fixturePids.every(pid => !processRunning(pid)));
  fixturePids.length = 0;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function until(check: () => boolean) {
  const deadline = Date.now() + FIXTURE_DEADLINE_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Windows process fixture deadline exceeded.');
    await delay(20);
  }
}

function launch(directory: string, label: string, command: string[]) {
  const child = spawn('bun', [wrapper, '--label', label, '--', ...command], {
    env: {
      ...process.env,
      CI: 'false',
      HEAVY_RUN_HELD: '',
      HEAVY_RUN_LEASE: '',
      HEAVY_RUN_GROUP_PID: '',
      HEAVY_RUN_WINDOWS_JOB: '',
      HEAVY_RUN_DIR: directory,
      HEAVY_RUN_SLOTS: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  let output = '';
  child.stdout?.on('data', chunk => {
    output += chunk;
  });
  child.stderr?.on('data', chunk => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  return { child, exited, output: () => output };
}

async function orphanFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nous-windows-job-'));
  directories.push(directory);
  const root = join(directory, 'root.mjs');
  const grandchild = join(directory, 'grandchild.mjs');
  const ready = join(directory, 'ready');
  const rootExited = join(directory, 'root-exited');
  const finish = join(directory, 'finish');
  writeFileSync(
    grandchild,
    `import { writeFileSync, existsSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
const timer = setInterval(() => { if (existsSync(process.argv[3])) { clearInterval(timer); } }, 20);
setTimeout(() => process.exit(2), 30000).unref();`
  );
  writeFileSync(
    root,
    `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const child = spawn(process.argv[2], process.argv.slice(3, 6), { detached: true, windowsHide: true, stdio: 'ignore' });
child.unref();
while (!existsSync(process.argv[4])) await new Promise(resolve => setTimeout(resolve, 20));
writeFileSync(process.argv[6], String(process.pid));`
  );
  const owner = launch(directory, 'windows-owner', [
    'bun',
    root,
    process.execPath,
    grandchild,
    ready,
    finish,
    rootExited,
  ]);
  await until(() => existsSync(rootExited));
  const rootPid = Number(readFileSync(rootExited, 'utf8'));
  const descendantPid = Number(readFileSync(ready, 'utf8'));
  fixturePids.push(rootPid, descendantPid);
  await until(() => !processRunning(rootPid));
  expect(processRunning(descendantPid)).toBe(true);
  const held = readdirSync(join(directory, 'lock')).find(name => name.startsWith('running-'));
  if (!held) throw new Error(`Missing Windows lease: ${owner.output()}`);
  const workerPid = Number(readFileSync(join(directory, 'lock', held), 'utf8').split('\n')[1]);
  const next = join(directory, 'next');
  const successor = launch(directory, 'windows-next', [
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync(process.argv[1], 'admitted')",
    next,
  ]);
  await until(() => successor.output().includes('position') || existsSync(next));
  expect(existsSync(next)).toBe(false);
  return {
    directory,
    owner,
    successor,
    descendantPid,
    workerPid,
    finish,
    next,
    id: held.replace('running-', ''),
  };
}

test.skipIf(process.platform !== 'win32')(
  'Windows root exit retains its Bun-to-Node grandchild lease',
  async () => {
    const fixture = await orphanFixture();
    writeFileSync(fixture.finish, 'finish');
    expect(await fixture.owner.exited).toBe(0);
    expect(await fixture.successor.exited).toBe(0);
    expect(processRunning(fixture.descendantPid)).toBe(false);
    expect(readFileSync(fixture.next, 'utf8')).toBe('admitted');
  }
);

test.skipIf(process.platform !== 'win32')(
  'Windows holder death kills its Job before the successor runs',
  async () => {
    const fixture = await orphanFixture();
    process.kill(fixture.workerPid, 'SIGKILL');
    expect(await fixture.successor.exited).toBe(0);
    expect(processRunning(fixture.descendantPid)).toBe(false);
    expect(readFileSync(fixture.next, 'utf8')).toBe('admitted');
    await fixture.owner.exited;
  }
);

test.skipIf(process.platform !== 'win32')(
  'Windows manual release terminates an orphaned Job before admission',
  async () => {
    const fixture = await orphanFixture();
    const release = spawn(process.execPath, [wrapper, 'release', fixture.id], {
      env: { ...process.env, HEAVY_RUN_DIR: fixture.directory },
      windowsHide: true,
      stdio: 'ignore',
    });
    processes.push(release);
    expect(await new Promise(resolveExit => release.once('exit', resolveExit))).toBe(0);
    expect(processRunning(fixture.descendantPid)).toBe(false);
    expect(await fixture.successor.exited).toBe(0);
    expect(readFileSync(fixture.next, 'utf8')).toBe('admitted');
    await fixture.owner.exited;
  }
);

test.skipIf(process.platform !== 'win32')(
  'Windows supervisor death terminates its disconnected Job',
  async () => {
    const fixture = await orphanFixture();
    if (!fixture.owner.child.pid) throw new Error('Supervisor requires a PID.');
    process.kill(fixture.owner.child.pid, 'SIGKILL');
    expect(await fixture.successor.exited).toBe(0);
    expect(processRunning(fixture.descendantPid)).toBe(false);
    expect(readFileSync(fixture.next, 'utf8')).toBe('admitted');
  }
);

test.skipIf(process.platform !== 'win32')(
  'Windows native launch preserves arguments, output, environment and exit code',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nous-windows-argv-'));
    directories.push(directory);
    const result = join(directory, 'result');
    const owner = launch(directory, 'windows-argv', [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), held: process.env.HEAVY_RUN_HELD, jobControl: process.env.HEAVY_RUN_WINDOWS_JOB ?? null, cwd: process.cwd() })); process.stdout.write('native-output'); process.exit(7)",
      result,
      '',
      'a"b',
      'tail\\',
      '字',
    ]);
    expect(await owner.exited).toBe(7);
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({
      args: ['', 'a"b', 'tail\\', '字'],
      held: '1',
      jobControl: null,
      cwd: process.cwd(),
    });
    expect(owner.output()).toContain('native-output');
    expect(existsSync(join(directory, 'lock'))).toBe(false);
  }
);
