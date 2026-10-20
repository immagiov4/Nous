import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';

const wrapper = resolve('scripts/heavy-run.mjs');
const runtime = process.execPath;
const directories: string[] = [];
const children: ChildProcess[] = [];
const completions = new Map<ChildProcess, Promise<number | null>>();
const barriers: string[] = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'nous-heavy-run-'));
  directories.push(path);
  return path;
}

function nativeNode(): string {
  if (!process.versions.bun) return process.execPath;
  // Bun's Vitest runner puts a Node alias on PATH; this fault injection needs native ESM bindings.
  for (const directory of new Set((process.env.PATH ?? '').split(delimiter))) {
    const candidate = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-p', 'process.versions.bun ? "" : process.execPath'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (probe.error) throw probe.error;
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  throw new Error('Native Node is required for filesystem fault injection.');
}

function start(
  path: string,
  label: string,
  command: string[],
  options: { environment?: NodeJS.ProcessEnv; entry?: string; executable?: string } = {}
) {
  const child = spawn(
    options.executable ?? runtime,
    [options.entry ?? wrapper, '--label', label, '--', ...command],
    {
      env: {
        ...process.env,
        CI: 'false',
        HEAVY_RUN_HELD: '',
        HEAVY_RUN_GROUP_PID: '',
        HEAVY_RUN_DIR: path,
        ...options.environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  children.push(child);
  completions.set(
    child,
    new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    })
  );
  return child;
}

async function until(condition: () => boolean | Promise<boolean>) {
  while (!(await condition())) await delay(20);
}

function output(child: ChildProcess) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  return async () => ({ code: await completions.get(child), stdout, stderr });
}

afterEach(async () => {
  for (const path of barriers.splice(0)) writeFileSync(path, '');
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>((resolveExit, reject) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', reject);
        killer.once('exit', () => resolveExit());
      });
    } else {
      child.kill();
    }
  }
  await Promise.all(completions.values());
  completions.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('heavy command admission', () => {
  test('admits several real processes in ticket order and excludes overlap', async () => {
    const path = directory();
    const fixture = join(path, 'worker.mjs');
    writeFileSync(
      fixture,
      `
      import { openSync, closeSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      const [path, label] = process.argv.slice(2);
      const active = join(path, 'active');
      closeSync(openSync(active, 'wx'));
      appendFileSync(join(path, 'order'), label + '\\n');
      while (!existsSync(join(path, 'release-' + label))) await delay(20);
      unlinkSync(active);
    `
    );
    const runs: ReturnType<typeof output>[] = [];
    for (const label of ['a', 'b', 'c', 'd']) {
      runs.push(output(start(path, label, [runtime, fixture, path, label])));
      await until(
        () =>
          existsSync(join(path, 'queue')) && readdirSync(join(path, 'queue')).length === runs.length
      );
    }
    await until(() => existsSync(join(path, 'order')));
    expect(readFileSync(join(path, 'order'), 'utf8')).toBe('a\n');
    for (const label of ['a', 'b', 'c', 'd']) {
      await until(() => readFileSync(join(path, 'order'), 'utf8').includes(`${label}\n`));
      writeFileSync(join(path, `release-${label}`), '');
    }
    for (const result of await Promise.all(runs.map(run => run()))) {
      expect(result).toMatchObject({ code: 0, stderr: '' });
    }
    expect(readFileSync(join(path, 'order'), 'utf8')).toBe('a\nb\nc\nd\n');
    expect(readdirSync(join(path, 'queue'))).toEqual([]);
    expect(existsSync(join(path, 'lock'))).toBe(false);
  });

  test.each([
    'dead',
    'expired',
  ] as const)('recovers a %s owner and stale queue ticket', async kind => {
    const path = directory();
    const lock = join(path, 'lock');
    const queue = join(path, 'queue');
    mkdirSync(lock);
    mkdirSync(queue);
    let pid = process.pid;
    if (kind === 'dead') {
      const dead = spawn(runtime, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
      pid = dead.pid as number;
      await new Promise(resolveExit => dead.once('exit', resolveExit));
    }
    const owner = JSON.stringify({ pid, label: 'stale', id: 'stale.json' });
    for (const file of [join(lock, 'stale.json'), join(queue, 'stale.json')]) {
      writeFileSync(file, owner);
      if (kind === 'expired') utimesSync(file, new Date(0), new Date(0));
    }
    const result = output(start(path, 'recovery', [runtime, '-e', 'console.log("recovered")']));
    expect(await result()).toMatchObject({ code: 0, stderr: '' });
    expect((await result()).stdout).toContain('recovered');
    expect(readdirSync(queue)).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });

  test.each([
    'CI',
    'HEAVY_RUN_HELD',
  ])('bypasses queue for %s and forwards arguments and failure', async flag => {
    const path = directory();
    const result = output(
      start(
        path,
        'bypass',
        [runtime, '-e', 'console.log(process.argv[1]); process.exit(7)', 'a b;$'],
        {
          environment: {
            [flag]: flag === 'CI' ? 'true' : '1',
            HEAVY_RUN_STALE_MS: 'unused-when-bypassed',
          },
        }
      )
    );
    expect(await result()).toMatchObject({ code: 7, stdout: 'a b;$\n', stderr: '' });
    expect(readdirSync(path)).toEqual([]);
  });

  test('nested wrappers inherit admission without making a second ticket', async () => {
    const path = directory();
    const result = output(
      start(path, 'outer', [
        runtime,
        wrapper,
        '--label',
        'inner',
        '--',
        runtime,
        '-e',
        'console.log(process.env.HEAVY_RUN_HELD)',
      ])
    );
    expect(await result()).toMatchObject({ code: 0, stderr: '' });
    expect((await result()).stdout).toBe('heavy-run: running outer\n1\n');
    expect(readdirSync(join(path, 'queue'))).toEqual([]);
  });

  test('package shell commands preserve expressions, environment and appended arguments', async () => {
    const path = directory();
    const script = join(path, 'arguments.mjs');
    writeFileSync(
      script,
      'console.log(JSON.stringify({flag:process.env.PROOF, args:process.argv.slice(2)}))'
    );
    const entry = join(path, 'shell.mjs');
    writeFileSync(
      entry,
      `process.argv.splice(4, 1, '--shell', 'PROOF=yes bun ${JSON.stringify(script)}', '--'); await import(${JSON.stringify(new URL('./heavy-run.mjs', import.meta.url).href)});`
    );
    const result = output(start(path, 'shell', ['two words', "a'b;$()"], { entry }));
    expect(await result()).toMatchObject({ code: 0, stderr: '' });
    expect((await result()).stdout).toContain(
      JSON.stringify({ flag: 'yes', args: ['two words', "a'b;$()"] })
    );
  });

  test.each([
    ['SIGTERM', 'waiting', false],
    ['SIGTERM', 'running', false],
    ['SIGINT', 'waiting', false],
    ['SIGINT', 'running', false],
    ['SIGTERM', 'running', true],
    ['SIGINT', 'running', true],
  ] as const)('%s cleans up a %s wrapper and its child (nested: %s)', async (signal, phase, nested) => {
    const path = directory();
    const marker = join(path, 'terminate');
    const signalOwner = join(path, 'signal-owner');
    const entry = join(path, 'signals.mjs');
    writeFileSync(
      entry,
      `
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(signalOwner)}, String(process.pid));
      if (process.platform === 'win32') {
        const timer = setInterval(() => {
          if (existsSync(${JSON.stringify(marker)})) { clearInterval(timer); process.emit(${JSON.stringify(signal)}); }
        }, 20);
      }
      await import(${JSON.stringify(new URL('./heavy-run.mjs', import.meta.url).href)});
    `
    );
    const lock = join(path, 'lock');
    if (phase === 'waiting') {
      mkdirSync(lock);
      writeFileSync(join(lock, 'other.json'), JSON.stringify({ pid: process.pid, label: 'other' }));
    }
    const childPid = join(path, 'child-pid');
    const descendantPid = join(path, 'descendant-pid');
    const descendant = join(path, 'descendant.mjs');
    writeFileSync(
      descendant,
      `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid)); setInterval(() => {}, 1000);`
    );
    const worker = join(path, 'child.mjs');
    writeFileSync(
      worker,
      `import { writeFileSync } from 'node:fs'; import { spawn } from 'node:child_process'; writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(descendant)}], { windowsHide: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`
    );
    const command = nested
      ? [runtime, entry, '--label', 'inner', '--', runtime, worker]
      : [runtime, worker];
    const supervisor = start(path, 'signal', command, {
      entry: nested || process.platform !== 'win32' ? wrapper : entry,
    });
    const result = output(supervisor);
    await until(() =>
      phase === 'waiting'
        ? existsSync(join(path, 'queue')) && readdirSync(join(path, 'queue')).length === 1
        : existsSync(descendantPid)
    );
    if (process.platform === 'win32') {
      // Windows kill() force-terminates a process; exercise the registered callback without it.
      writeFileSync(marker, '');
    } else {
      const target = nested ? Number(readFileSync(signalOwner, 'utf8')) : supervisor.pid;
      expect(target).toBeDefined();
      process.kill(target as number, signal);
    }
    expect((await result()).code).not.toBe(0);
    expect(readdirSync(join(path, 'queue'))).toEqual([]);
    if (phase === 'waiting') {
      expect(existsSync(join(lock, 'other.json'))).toBe(true);
    } else {
      expect(existsSync(lock)).toBe(false);
      const pid = Number(readFileSync(childPid, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      const descendantProcessId = Number(readFileSync(descendantPid, 'utf8'));
      await until(() => {
        try {
          process.kill(descendantProcessId, 0);
          return false;
        } catch {
          return true;
        }
      });
    }
  });

  test('status describes a live owner and waiting tickets without changing them', async () => {
    const path = directory();
    mkdirSync(join(path, 'lock'));
    mkdirSync(join(path, 'queue'));
    const record = JSON.stringify({ pid: process.pid, label: 'owner' });
    writeFileSync(join(path, 'lock', 'owner.json'), record);
    writeFileSync(
      join(path, 'queue', 'waiter.json'),
      JSON.stringify({ pid: process.pid, label: 'waiter' })
    );
    const entry = join(path, 'status.mjs');
    writeFileSync(
      entry,
      `process.argv = [process.execPath, ${JSON.stringify(wrapper)}, 'status']; await import(${JSON.stringify(new URL('./heavy-run.mjs', import.meta.url).href)});`
    );
    const result = output(start(path, 'status', [runtime, '-e', ''], { entry }));
    expect(await result()).toMatchObject({ code: 0, stderr: '' });
    expect((await result()).stdout).toContain(`Owner: owner (PID ${process.pid})`);
    expect((await result()).stdout).toContain(`1. waiter (PID ${process.pid})`);
    expect(readFileSync(join(path, 'lock', 'owner.json'), 'utf8')).toBe(record);
  });

  test('releases admission after spawn errors and preserves exit codes', async () => {
    const path = directory();
    expect(
      (await output(start(path, 'missing', ['nous-command-that-does-not-exist']))()).code
    ).toBe(1);
    expect(existsSync(join(path, 'lock'))).toBe(false);
    expect((await output(start(path, 'failure', [runtime, '-e', 'process.exit(9)']))()).code).toBe(
      9
    );
    expect(readdirSync(join(path, 'queue'))).toEqual([]);
  });

  test('rejects stale configuration that cannot outlast one heartbeat', async () => {
    const path = directory();
    const result = output(
      start(path, 'invalid-stale', [runtime, '-e', ''], {
        environment: { HEAVY_RUN_STALE_MS: '30000' },
      })
    );
    expect(await result()).toMatchObject({ code: 1 });
    expect((await result()).stderr).toContain('heartbeat');
    expect(readdirSync(path)).toEqual([]);
  });

  test('preserves a stale lock until its recorded child exits', async () => {
    const path = directory();
    mkdirSync(join(path, 'lock'));
    const lock = join(path, 'lock', 'stale.json');
    const release = join(path, 'release');
    const child = spawn(
      runtime,
      [
        '-e',
        'const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])) clearInterval(timer)},20)',
        release,
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    const completion = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
    children.push(child);
    completions.set(child, completion);
    const record = `${JSON.stringify({ pid: process.pid, label: 'frozen' })}\n${child.pid}`;
    writeFileSync(lock, record);
    utimesSync(lock, new Date(0), new Date(0));
    const waiter = start(path, 'next', [runtime, '-e', 'console.log("admitted")']);
    const result = output(waiter);
    let waiting = false;
    waiter.stdout?.on('data', chunk => {
      waiting ||= String(chunk).includes('position');
    });
    await until(() => waiting);
    expect(readFileSync(lock, 'utf8')).toBe(record);
    writeFileSync(release, '');
    await completion;
    expect(await result()).toMatchObject({ code: 0, stderr: '' });
    expect((await result()).stdout).toContain('admitted');
    expect(existsSync(join(path, 'lock'))).toBe(false);
  });

  test('a supervisor recovered before child registration cannot launch after losing admission', async () => {
    const path = directory();
    const paused = join(path, 'paused');
    const resume = join(path, 'resume');
    const release = join(path, 'release');
    barriers.push(resume, release);
    const firstStarted = join(path, 'first-started');
    const nextStarted = join(path, 'next-started');
    const worker = join(path, 'worker.mjs');
    writeFileSync(
      worker,
      `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      writeFileSync(process.argv[2], 'started');
      while (!existsSync(process.argv[3])) await delay(20);
    `
    );
    const entry = join(path, 'pause-registration.mjs');
    writeFileSync(
      entry,
      `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWrite = fs.writeFileSync;
      let paused = false;
      fs.writeFileSync = (target, content, ...options) => {
        if (!paused && typeof target === 'number' && typeof content === 'string' && content.startsWith('\\n')) {
          paused = true;
          originalWrite(${JSON.stringify(paused)}, 'ready');
          while (!fs.existsSync(${JSON.stringify(resume)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        return originalWrite(target, content, ...options);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(new URL('./heavy-run.mjs', import.meta.url).href)});
    `
    );
    const firstChild = start(path, 'expired', [runtime, worker, firstStarted, release], {
      entry,
      executable: nativeNode(),
    });
    const first = output(firstChild);
    await until(async () => {
      if (firstChild.exitCode !== null) throw new Error(JSON.stringify(await first()));
      if (existsSync(firstStarted)) throw new Error('Command started before child registration.');
      return existsSync(paused);
    });
    const owner = join(path, 'lock', readdirSync(join(path, 'lock'))[0]);
    utimesSync(owner, new Date(0), new Date(0));
    const next = output(start(path, 'next', [runtime, worker, nextStarted, release]));
    await until(() => existsSync(nextStarted));
    expect(existsSync(firstStarted)).toBe(false);
    writeFileSync(resume, '');
    expect(await first()).toMatchObject({ code: 1 });
    expect((await first()).stderr).toContain('Queue ticket expired');
    expect(existsSync(firstStarted)).toBe(false);
    expect(existsSync(join(path, 'lock'))).toBe(true);
    writeFileSync(release, '');
    expect(await next()).toMatchObject({ code: 0, stderr: '' });
    expect(existsSync(join(path, 'lock'))).toBe(false);
  });

  test('refreshes the owner heartbeat independently of a silent child', async () => {
    const path = directory();
    const release = join(path, 'release');
    const started = join(path, 'started');
    const child = start(path, 'silent', [
      runtime,
      '-e',
      `const fs = require('node:fs'); fs.writeFileSync(process.argv[2], ''); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(t); }, 20);`,
      release,
      started,
    ]);
    const result = output(child);
    await until(() => existsSync(started));
    const owner = join(path, 'lock', readdirSync(join(path, 'lock'))[0]);
    await until(() => readFileSync(owner, 'utf8').includes('\n'));
    const initial = statSync(owner).mtimeMs;
    await until(() => statSync(owner).mtimeMs > initial);
    writeFileSync(release, '');
    expect((await result()).code).toBe(0);
  }, 40_000);
});
