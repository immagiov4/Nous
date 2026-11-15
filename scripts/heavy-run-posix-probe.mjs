import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setInterval as ticks } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processRunning } from './heavy-run-process.mjs';

const FIXTURE_TIMEOUT_MS = 8000;
// Observe at least one complete admission poll after the worker exits.
const ADMISSION_OBSERVATION_MS = 1500;
const wrapper = fileURLToPath(new URL('./heavy-run.mjs', import.meta.url));

function stopFixtureGroup(group) {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function until(condition) {
  const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
  if (condition()) return;
  for await (const check of ticks(20, condition)) {
    if (check()) break;
    if (Date.now() > deadline) throw new Error('POSIX fixture deadline exceeded.');
  }
}

async function bounded(completion) {
  let timer;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('POSIX completion deadline exceeded.')),
          FIXTURE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exercise normal completion and leaderless release against real POSIX groups. */
export async function probePosixLease(mode = 'finish') {
  const directory = mkdtempSync(join(tmpdir(), 'nous-posix-lease-'));
  const environment = {
    ...process.env,
    CI: 'false',
    HEAVY_RUN_HELD: '',
    HEAVY_RUN_LEASE: '',
    HEAVY_RUN_GROUP_PID: '',
    HEAVY_RUN_DIR: directory,
    HEAVY_RUN_SLOTS: '1',
  };
  const children = [];
  let group;
  function launch(args, entry = wrapper) {
    const child = spawn(process.execPath, [entry, ...args], {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    children.push(child);
    return { child, completion, output: () => output };
  }
  try {
    const ready = join(directory, 'descendant');
    const rootPid = join(directory, 'root-pid');
    const exitRoot = join(directory, 'exit-root');
    const finish = join(directory, 'finish');
    const next = join(directory, 'next');
    const descendant = join(directory, 'descendant.mjs');
    const root = join(directory, 'root.mjs');
    const repeatSignal = mode.startsWith('repeat-') ? mode.slice('repeat-'.length) : null;
    const interruptions = join(directory, 'interruptions');
    const entry = join(directory, 'entry.mjs');
    if (repeatSignal) {
      writeFileSync(
        entry,
        `import { writeFileSync } from 'node:fs';
import { main } from ${JSON.stringify(new URL('./heavy-run.mjs', import.meta.url).href)};
let count = 0;
process.exitCode = await main(process.argv.slice(2), { onInterrupt: () => {
  writeFileSync(${JSON.stringify(interruptions)}, String(++count));
  return count === 1;
} });`
      );
    }
    writeFileSync(
      descendant,
      `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
const timer = setInterval(() => { if (existsSync(process.argv[3])) clearInterval(timer); }, 20);
setTimeout(() => process.exit(2), 30000).unref();`
    );
    writeFileSync(
      root,
      `import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const child = spawn(process.execPath, process.argv.slice(2, 5), { stdio: 'ignore' });
child.unref();
writeFileSync(process.argv[5], String(process.pid));
while (!existsSync(process.argv[6])) await new Promise(resolve => setTimeout(resolve, 20));`
    );
    const owner = launch(
      [
        '--label',
        'posix-owner',
        '--',
        process.execPath,
        root,
        descendant,
        ready,
        finish,
        rootPid,
        exitRoot,
      ],
      repeatSignal ? entry : wrapper
    );
    await until(() => existsSync(ready) && existsSync(rootPid));
    const held = readdirSync(join(directory, 'lock')).find(name => name.startsWith('running-'));
    assert.ok(held, owner.output());
    group = Number(readFileSync(join(directory, 'lock', held), 'utf8').split('\n')[1]);
    const descendantPid = Number(readFileSync(ready, 'utf8'));
    writeFileSync(exitRoot, 'exit');
    await until(() => !processRunning(group));
    assert.equal(processRunning(descendantPid), true);
    const successor = launch([
      '--label',
      'posix-next',
      '--',
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'admitted')",
      next,
    ]);
    await until(() => successor.output().includes('position') || existsSync(next));
    await delay(ADMISSION_OBSERVATION_MS);
    assert.equal(
      existsSync(next),
      false,
      'A descendant must retain capacity after its root exits.'
    );
    if (repeatSignal) {
      owner.child.kill(repeatSignal);
      await until(() => existsSync(interruptions));
      assert.equal(readFileSync(interruptions, 'utf8'), '1');
      assert.equal(processRunning(descendantPid), true);
      owner.child.kill(repeatSignal);
    } else if (mode === 'release') {
      const cleanup = launch(['release', held.replace('running-', '')]);
      assert.equal(await bounded(cleanup.completion), 0, cleanup.output());
    } else if (mode === 'SIGINT' || mode === 'SIGTERM') {
      owner.child.kill(mode);
    } else {
      writeFileSync(finish, 'finish');
    }
    const interrupted = repeatSignal || mode === 'SIGINT' || mode === 'SIGTERM';
    assert.equal(await bounded(owner.completion), interrupted ? 130 : 0, owner.output());
    if (repeatSignal) assert.equal(readFileSync(interruptions, 'utf8'), '2');
    assert.equal(await bounded(successor.completion), 0, successor.output());
    assert.equal(processRunning(descendantPid), false);
    assert.equal(readFileSync(next, 'utf8'), 'admitted');
    return { successor: 'admitted', descendantRunning: false };
  } finally {
    if (group) stopFixtureGroup(group);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await probePosixLease(process.argv[2] ?? 'finish')));
