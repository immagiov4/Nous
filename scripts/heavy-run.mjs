import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  futimesSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const POLL_MS = 1_000;
const EXPIRED_TICKET = 'Queue ticket expired; run the command again.';
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function readEntry(path, staleMs) {
  try {
    const stat = statSync(path);
    const content = readFileSync(path, 'utf8');
    // An O_EXCL creator may still be writing its record. Its file reserves its place.
    let owner = null;
    try {
      const [record, childPid] = content.split('\n');
      owner = record ? { ...JSON.parse(record), childPid: Number(childPid) || undefined } : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return {
      path,
      owner,
      created: stat.birthtimeMs,
      stale:
        !(owner?.childPid && pidAlive(owner.childPid)) &&
        (Date.now() - stat.mtimeMs > staleMs || (owner && !pidAlive(owner.pid))),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function removeLock(lock, ownerFile) {
  if (ownerFile) {
    const retired = `retired-${ownerFile}`;
    try {
      // Retirement and activation contend for the same name; an expired owner cannot launch later.
      renameSync(join(lock, ownerFile), join(lock, retired));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    removeFile(join(lock, retired));
  }
  try {
    // Never recursively remove a lock: another owner has a different record filename.
    rmdirSync(lock);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function readLock(lock, staleMs) {
  try {
    const [ownerFile] = readdirSync(lock);
    if (ownerFile) return readEntry(join(lock, ownerFile), staleMs);
    return { owner: null, stale: Date.now() - statSync(lock).mtimeMs > staleMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readQueue(queue, staleMs, prune) {
  return readdirSync(queue)
    .map(name => readEntry(join(queue, name), staleMs))
    .filter(entry => {
      if (!entry) return false;
      if (prune && entry.stale) {
        removeFile(entry.path);
        const prepared = join(dirname(queue), 'claims', basename(entry.path));
        removeFile(join(prepared, basename(entry.path)));
        removeLock(prepared);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.created - b.created || basename(a.path).localeCompare(basename(b.path)));
}

function createTicket(queue, label) {
  const timestamp = Date.now();
  for (let sequence = 0; ; sequence++) {
    const id = `${timestamp}-${String(sequence).padStart(10, '0')}.json`;
    const path = join(queue, id);
    try {
      const fd = openSync(path, 'wx');
      const owner = { pid: process.pid, label, id };
      writeFileSync(fd, JSON.stringify(owner));
      return { path, fd, owner };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function describeOwner(owner) {
  return owner ? `${owner.label} (PID ${owner.pid})` : 'initializing';
}

function claimLock(prepared, lock) {
  try {
    // Publish a populated directory atomically, so another owner's cleanup cannot see it empty.
    renameSync(prepared, lock);
    return true;
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
    if (error.code === 'EPERM' && existsSync(lock)) return false;
    throw error;
  }
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', reject);
      killer.once('exit', resolve);
    });
  } else {
    try {
      // Interruption must stop every owned group member, including tools that ignore SIGTERM.
      const groupPid = Number(process.env.HEAVY_RUN_GROUP_PID || child.pid);
      if (!Number.isInteger(groupPid) || groupPid <= 0)
        throw new Error('Invalid heavy-run process group.');
      process.kill(-groupPid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function runCommand(command, environment, abort, onSpawn) {
  const detached = process.platform !== 'win32' && !process.env.HEAVY_RUN_GROUP_PID;
  // The POSIX launcher records its own group before exec, preserving one group across nested wrappers.
  const invocation =
    detached && !onSpawn
      ? ['sh', '-c', 'export HEAVY_RUN_GROUP_PID=$$; exec "$@"', 'heavy-run', ...command]
      : command;
  const child = spawn(invocation[0], invocation.slice(1), {
    env: environment,
    stdio: onSpawn ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
    windowsHide: true,
    detached,
  });
  let stopping;
  const stopped = () => {
    stopping = stopChild(child).catch(error => {
      process.stderr.write(`heavy-run: failed to stop command: ${error.message}\n`);
    });
  };
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve(code ?? (abort.signal.reason === 'SIGINT' || signal === 'SIGINT' ? 130 : 143))
    );
  });
  abort.signal.addEventListener('abort', stopped, { once: true });
  try {
    if (child.pid && onSpawn) {
      onSpawn(child.pid);
      child.send('run');
    }
    return await completed;
  } catch (error) {
    await stopChild(child);
    await completed.catch(() => {});
    throw error;
  } finally {
    await stopping;
    abort.signal.removeEventListener('abort', stopped);
  }
}

async function workerCommand(args) {
  if (!process.send || args[1] !== '--' || !args[2])
    throw new Error('Worker requires supervisor IPC.');
  const admitted = await new Promise(resolve => {
    const received = message => {
      process.removeListener('disconnect', disconnected);
      resolve(message === 'run');
    };
    const disconnected = () => {
      process.removeListener('message', received);
      resolve(false);
    };
    process.once('message', received);
    process.once('disconnect', disconnected);
  });
  if (process.connected) process.disconnect();
  if (!admitted) return null;
  if (process.platform !== 'win32' && !process.env.HEAVY_RUN_GROUP_PID) {
    process.env.HEAVY_RUN_GROUP_PID = String(process.pid);
  }
  return args.slice(2);
}

function activateLock(lock, ticket, childPid) {
  writeFileSync(ticket.fd, `\n${childPid}`);
  const running = `running-${ticket.owner.id}`;
  try {
    renameSync(join(lock, ticket.owner.id), join(lock, running));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(EXPIRED_TICKET);
    throw error;
  }
  return running;
}

function parseCommand(args) {
  if (args[0] !== '--label' || !args[1]) throw new Error('A --label is required.');
  if (args[2] === '--shell' && args[3] && args[4] === '--') {
    // Bun's cross-platform shell handles package expressions; quote each forwarded argument.
    const tail = args.slice(5).map(argument => `'${argument.replaceAll("'", "'\\''")}'`);
    return ['bun', 'exec', [args[3], ...tail].join(' ')];
  }
  if (args[2] === '--' && args[3]) return args.slice(3);
  throw new Error('Usage: heavy-run.mjs --label "who/what" -- command [args...] | status');
}

async function queuedRun({ directory, staleMs, label, command, abort }) {
  const queue = join(directory, 'queue');
  const lock = join(directory, 'lock');
  mkdirSync(queue, { recursive: true });
  const ticket = createTicket(queue, label);
  const prepared = join(directory, 'claims', ticket.owner.id);
  let ownerFile = ticket.owner.id;
  const heartbeat = setInterval(() => {
    const now = new Date();
    futimesSync(ticket.fd, now, now);
  }, HEARTBEAT_MS);
  try {
    mkdirSync(prepared, { recursive: true });
    // Both names share one record and heartbeat; publication never exposes a partial owner record.
    linkSync(ticket.path, join(prepared, ticket.owner.id));
    let lastReport = 0;
    while (!abort.signal.aborted) {
      const waiting = readQueue(queue, staleMs, true);
      const owner = readLock(lock, staleMs);
      const position = waiting.findIndex(entry => entry.path === ticket.path);
      if (position < 0) throw new Error(EXPIRED_TICKET);
      if (position === 0) {
        if (owner?.stale) removeLock(lock, owner.path && basename(owner.path));
        if (claimLock(prepared, lock)) {
          if (!existsSync(ticket.path)) throw new Error(EXPIRED_TICKET);
          process.stdout.write(`heavy-run: running ${label}\n`);
          const worker = [process.execPath, SCRIPT_PATH, '--worker', '--', ...command];
          return await runCommand(worker, { ...process.env, HEAVY_RUN_HELD: '1' }, abort, pid => {
            // The worker waits for IPC permission until activation has won against stale recovery.
            ownerFile = activateLock(lock, ticket, pid);
          });
        }
      }
      if (Date.now() - lastReport >= HEARTBEAT_MS) {
        process.stdout.write(
          `heavy-run: ${label}, position ${position + 1}; owner: ${owner ? describeOwner(owner.owner) : 'free'}\n`
        );
        lastReport = Date.now();
      }
      await delay(POLL_MS, undefined, { signal: abort.signal });
    }
    return 130;
  } finally {
    clearInterval(heartbeat);
    removeLock(lock, ownerFile);
    removeFile(join(prepared, ticket.owner.id));
    removeLock(prepared);
    closeSync(ticket.fd);
    removeFile(ticket.path);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const directory = process.env.HEAVY_RUN_DIR || join(homedir(), '.agent-questions', 'heavy-run');
  const worker = args[0] === '--worker';
  const bypass = worker || process.env.CI === 'true' || process.env.HEAVY_RUN_HELD === '1';
  const staleMs = bypass
    ? DEFAULT_STALE_MS
    : Number(process.env.HEAVY_RUN_STALE_MS ?? DEFAULT_STALE_MS);
  if (!Number.isFinite(staleMs) || staleMs <= HEARTBEAT_MS)
    throw new Error(`HEAVY_RUN_STALE_MS must exceed the ${HEARTBEAT_MS} ms heartbeat interval.`);
  if (args[0] === 'status') {
    const owner = readLock(join(directory, 'lock'), staleMs);
    console.log(`Owner: ${owner ? describeOwner(owner.owner) : 'free'}`);
    const queue = join(directory, 'queue');
    if (existsSync(queue)) {
      for (const [index, entry] of readQueue(queue, staleMs, false).entries()) {
        console.log(`${index + 1}. ${describeOwner(entry.owner)}${entry.stale ? ' [stale]' : ''}`);
      }
    }
    return 0;
  }
  const command = worker ? await workerCommand(args) : parseCommand(args);
  if (!command) return 1;
  const abort = new AbortController();
  const interrupt = () => abort.abort('SIGINT');
  const terminate = () => abort.abort('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    if (bypass) {
      return await runCommand(command, process.env, abort);
    }
    return await queuedRun({ directory, staleMs, label: args[1], command, abort });
  } catch (error) {
    if (abort.signal.aborted && error.name === 'AbortError') return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(`heavy-run: ${error.message}`);
    process.exitCode = 1;
  }
);
