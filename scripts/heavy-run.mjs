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
import { setInterval as ticks } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_SLOTS = 4;
const HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const POLL_MS = 1_000;
// Unoccupied leases get one rounded-up startup interval plus one admission poll (see TESTING.md).
const IDLE_MS = 2 * POLL_MS;
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

function readEntry(path, staleMs, held = false) {
  try {
    const stat = statSync(path);
    const content = readFileSync(path, 'utf8');
    // An O_EXCL creator may still be writing its record. Its file reserves its place.
    let owner = null;
    try {
      const [record, childPid, startedAt] = content.split('\n');
      owner = record
        ? {
            ...JSON.parse(record),
            childPid: Number(childPid) || undefined,
            startedAt: Number(startedAt) || undefined,
          }
        : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const childAlive = owner?.childPid && pidAlive(owner.childPid);
    const expired = Date.now() - stat.mtimeMs > (held ? IDLE_MS : staleMs);
    const ownerGone = owner && !pidAlive(owner.pid);
    return {
      path,
      owner,
      created: stat.birthtimeMs,
      lastActivity: stat.mtimeMs,
      // A live command always retains capacity, including after its supervisor exits.
      stale: childAlive ? false : Boolean(expired || ownerGone || owner?.childPid),
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
      if (error.code === 'ENOENT') return false;
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
  return true;
}

function readLock(lock, staleMs) {
  try {
    const owners = readdirSync(lock)
      .sort()
      // A record may be renamed for activation after enumeration. Reserve capacity until the next poll.
      .map(name => readEntry(join(lock, name), staleMs, true) ?? { owner: null, stale: false });
    if (owners.length) return owners;
    return [{ owner: null, stale: Date.now() - statSync(lock).mtimeMs > IDLE_MS }];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readQueue(queue, staleMs, prune) {
  return readdirSync(queue)
    .map(name => readEntry(join(queue, name), staleMs))
    .filter(entry => {
      if (!entry) return false;
      if (prune && entry.stale) {
        removeTicket(queue, basename(entry.path));
        return false;
      }
      return true;
    })
    .sort((a, b) => a.created - b.created || basename(a.path).localeCompare(basename(b.path)));
}

function removeTicket(queue, id) {
  if (!id || basename(id) !== id || !id.endsWith('.json'))
    throw new Error('release requires a lease id from status.');
  const removed = removeFile(join(queue, id));
  const prepared = join(dirname(queue), 'claims', id);
  removeFile(join(prepared, id));
  removeLock(prepared);
  return removed;
}

function createTicket(queue, label, weight, command) {
  const timestamp = Date.now();
  for (let sequence = 0; ; sequence++) {
    const id = `${timestamp}-${String(sequence).padStart(10, '0')}.json`;
    const path = join(queue, id);
    try {
      const fd = openSync(path, 'wx');
      const owner = { pid: process.pid, label, id, weight, command, queuedAt: timestamp };
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

function claimLock(prepared, lock, ticket) {
  const id = ticket.owner.id;
  try {
    mkdirSync(lock, { recursive: true });
    // Queue residence is not idle ownership: start the lease clock at publication.
    const now = new Date();
    futimesSync(ticket.fd, now, now);
    // Only the first unadmitted FIFO ticket publishes a reservation. One link reserves its full weight.
    linkSync(join(prepared, id), join(lock, id));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function stopChild(child, ownedGroupPid = process.env.HEAVY_RUN_GROUP_PID || child?.pid) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const code = await new Promise((resolve, reject) => {
      const killer = spawn(
        join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
        }
      );
      killer.once('error', reject);
      killer.once('exit', resolve);
    });
    if (code !== 0 && pidAlive(child.pid))
      throw new Error('Failed to stop the lease command tree.');
  } else {
    try {
      // Interruption must stop every owned group member, including tools that ignore SIGTERM.
      const groupPid = Number(ownedGroupPid);
      if (!Number.isInteger(groupPid) || groupPid <= 0)
        throw new Error('Invalid heavy-run process group.');
      process.kill(-groupPid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

export async function runCommand(command, environment, abort, onSpawn) {
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
  let stopping = Promise.resolve();
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

export async function workerCommand(args, channel = process) {
  if (!channel.send || args[1] !== '--' || !args[2])
    throw new Error('Worker requires supervisor IPC.');
  const admitted = await new Promise(resolve => {
    const received = message => {
      clearTimeout(deadline);
      channel.removeListener('disconnect', disconnected);
      resolve(message === 'run');
    };
    const disconnected = () => {
      clearTimeout(deadline);
      channel.removeListener('disconnect', disconnected);
      channel.removeListener('message', received);
      resolve(false);
    };
    // A registered worker is not heavy work until admission arrives.
    const deadline = setTimeout(disconnected, IDLE_MS);
    channel.once('message', received);
    channel.once('disconnect', disconnected);
  });
  if (channel.connected) channel.disconnect();
  if (!admitted) return null;
  if (process.platform !== 'win32' && !process.env.HEAVY_RUN_GROUP_PID) {
    process.env.HEAVY_RUN_GROUP_PID = String(process.pid);
  }
  return args.slice(2);
}

function activateLock(lock, ticket, childPid) {
  writeFileSync(ticket.fd, `\n${childPid}\n${Date.now()}`);
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
  const options = [...args];
  let weight = 1;
  if (options[2] === '--weight') {
    weight = Number(options[3]);
    options.splice(2, 2);
  }
  return { command: parseInvocation(options), weight };
}

function parseInvocation(args) {
  if (args[0] !== '--label' || !args[1]) throw new Error('A --label is required.');
  if (args[2] === '--shell' && args[3] && args[4] === '--') {
    // Bun's cross-platform shell handles package expressions; quote each forwarded argument.
    const escapedQuote = String.raw`'\''`;
    const tail = args.slice(5).map(argument => `'${argument.replaceAll("'", escapedQuote)}'`);
    return ['bun', 'exec', [args[3], ...tail].join(' ')];
  }
  if (args[2] === '--' && args[3]) return args.slice(3);
  throw new Error(
    'Usage: heavy-run.mjs --label "who/what" -- command [args...] | status | release <id>'
  );
}

function retireIdleOwners(owners, lock, queue) {
  for (const entry of owners) {
    if (!entry.stale || !removeLock(lock, entry.path && basename(entry.path))) continue;
    if (entry.path) {
      const id =
        entry.owner?.id ?? basename(entry.path).replace(/^(?:running-|releasing-|retired-)+/u, '');
      removeTicket(queue, id);
    }
  }
}

function tryClaim(context) {
  const { queue, lock, prepared, ticket, staleMs, label, slots, weight } = context;
  const owners = readLock(lock, staleMs);
  // Legacy manual tickets may have no record id and otherwise remain first in the queue.
  retireIdleOwners(owners, lock, queue);
  const admitted = new Set(owners.map(entry => entry.owner?.id).filter(Boolean));
  const waiting = readQueue(queue, staleMs, true).filter(entry => !admitted.has(entry.owner?.id));
  const position = waiting.findIndex(entry => entry.path === ticket.path);
  if (position < 0) throw new Error(EXPIRED_TICKET);
  if (position === 0) {
    // Activation can win retirement by renaming its record; count that surviving reservation too.
    const used = readLock(lock, staleMs).reduce(
      (sum, entry) => sum + (entry.owner ? (entry.owner.weight ?? 1) : slots),
      0
    );
    if (used + weight <= slots && claimLock(prepared, lock, ticket)) {
      if (!existsSync(ticket.path)) throw new Error(EXPIRED_TICKET);
      return true;
    }
  }
  if (Date.now() - context.lastReport >= HEARTBEAT_MS) {
    process.stdout.write(
      `heavy-run: ${label}, position ${position + 1}; owners: ${owners.length ? owners.map(entry => describeOwner(entry.owner)).join(', ') : 'free'}\n`
    );
    context.lastReport = Date.now();
  }
  return false;
}

async function waitForLock(context, abort) {
  if (abort.signal.aborted) return false;
  if (tryClaim(context)) return true;
  for await (const pollContext of ticks(POLL_MS, context, { signal: abort.signal })) {
    if (tryClaim(pollContext)) return true;
  }
  return false;
}

async function queuedRun({ directory, staleMs, label, command, abort, slots, weight }) {
  const queue = join(directory, 'queue');
  const lock = join(directory, 'lock');
  mkdirSync(queue, { recursive: true });
  const ticket = createTicket(queue, label, weight, command);
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
    const claimed = await waitForLock(
      { queue, lock, prepared, ticket, staleMs, label, slots, weight, lastReport: 0 },
      abort
    );
    if (!claimed) return 130;
    process.stdout.write(`heavy-run: running ${label}\n`);
    const worker = [process.execPath, SCRIPT_PATH, '--worker', '--', ...command];
    return await runCommand(
      worker,
      { ...process.env, HEAVY_RUN_HELD: '1', HEAVY_RUN_LEASE: ticket.owner.id },
      abort,
      pid => {
        // The worker waits for IPC permission until activation has won against stale recovery.
        ownerFile = activateLock(lock, ticket, pid);
      }
    );
  } finally {
    clearInterval(heartbeat);
    removeLock(lock, ownerFile);
    removeFile(join(prepared, ticket.owner.id));
    removeLock(prepared);
    closeSync(ticket.fd);
    removeFile(ticket.path);
  }
}

function showStatus(directory, staleMs, slots) {
  const owners = readLock(join(directory, 'lock'), staleMs);
  console.log(`Slots: ${slots}`);
  if (!owners.length) console.log('Owner: free');
  for (const entry of owners) {
    console.log(
      `Owner: ${describeOwner(entry.owner)}; weight ${entry.owner?.weight ?? 1}${entry.stale ? ' [stale]' : ''}`
    );
    showDetails(entry);
  }
  const admitted = new Set(owners.map(entry => entry.owner?.id).filter(Boolean));
  const queue = join(directory, 'queue');
  if (!existsSync(queue)) return;
  for (const [index, entry] of readQueue(queue, staleMs, false)
    .filter(entry => !admitted.has(entry.owner?.id))
    .entries()) {
    console.log(
      `${index + 1}. ${describeOwner(entry.owner)}${entry.stale ? ' [stale]' : ''}; weight ${entry.owner?.weight ?? 1}`
    );
    showDetails(entry);
  }
}

function showDetails(entry) {
  const timestamp = value => (value ? new Date(value).toISOString() : 'pending');
  console.log(
    `  id: ${entry.owner?.id ?? (entry.path && basename(entry.path)) ?? 'initializing'}; command: ${JSON.stringify(entry.owner?.command ?? [])}; queued: ${timestamp(entry.owner?.queuedAt ?? entry.created)}; start: ${timestamp(entry.owner?.startedAt)}; last activity: ${timestamp(entry.lastActivity)}`
  );
}

async function releaseLease(directory, id, staleMs) {
  let removed = removeTicket(join(directory, 'queue'), id);
  const lock = join(directory, 'lock');
  // Activation renames once; retirement must win that same race before stopping the worker.
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = readLock(lock, staleMs).find(
      entry => entry.path && [id, `running-${id}`, `releasing-${id}`].includes(basename(entry.path))
    );
    if (!entry) break;
    const retired = `releasing-${id}`;
    try {
      renameSync(entry.path, join(lock, retired));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const owner = readEntry(join(lock, retired), staleMs)?.owner;
    if (owner?.childPid)
      await stopChild({ pid: owner.childPid, exitCode: null, signalCode: null }, owner.childPid);
    removeLock(lock, retired);
    removed = true;
    break;
  }
  console.log(`heavy-run: ${removed ? 'released' : 'not found'} ${id}`);
  return removed ? 0 : 1;
}

function inheritedLeaseActive(directory, staleMs) {
  return (
    process.env.HEAVY_RUN_LEASE &&
    readLock(join(directory, 'lock'), staleMs).some(
      entry => entry.owner?.id === process.env.HEAVY_RUN_LEASE && !entry.stale
    )
  );
}

function localSettings(bypass) {
  const staleMs = bypass
    ? DEFAULT_STALE_MS
    : Number(process.env.HEAVY_RUN_STALE_MS ?? DEFAULT_STALE_MS);
  if (!Number.isFinite(staleMs) || staleMs <= HEARTBEAT_MS)
    throw new Error(`HEAVY_RUN_STALE_MS must exceed the ${HEARTBEAT_MS} ms heartbeat interval.`);
  const slots = bypass ? DEFAULT_SLOTS : Number(process.env.HEAVY_RUN_SLOTS ?? DEFAULT_SLOTS);
  if (!Number.isSafeInteger(slots) || slots < 1)
    throw new Error('HEAVY_RUN_SLOTS must be a positive integer.');
  return { staleMs, slots };
}

export async function main(args = process.argv.slice(2)) {
  const directory = process.env.HEAVY_RUN_DIR || join(homedir(), '.agent-questions', 'heavy-run');
  const worker = args[0] === '--worker';
  const bypass = worker || process.env.CI === 'true' || process.env.HEAVY_RUN_HELD === '1';
  const { staleMs, slots } = localSettings(bypass);
  if (args[0] === 'status') {
    showStatus(directory, staleMs, slots);
    return 0;
  }
  if (args[0] === 'release') return releaseLease(directory, args[1], staleMs);
  if (!bypass && inheritedLeaseActive(directory, staleMs))
    throw new Error(
      'A nested command must reuse HEAVY_RUN_HELD; release its current lease before queuing another.'
    );
  const { command, weight } = worker
    ? { command: await workerCommand(args), weight: 1 }
    : parseCommand(args);
  if (!Number.isSafeInteger(weight) || weight < 1 || (!bypass && weight > slots))
    throw new Error('--weight must be a positive integer no greater than HEAVY_RUN_SLOTS.');
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
    return await queuedRun({ directory, staleMs, label: args[1], command, abort, slots, weight });
  } catch (error) {
    if (abort.signal.aborted && error.name === 'AbortError') return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`heavy-run: ${error.message}`);
    process.exitCode = 1;
  }
}
