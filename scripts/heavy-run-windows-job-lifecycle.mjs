import { setInterval as ticks } from 'node:timers/promises';

/** Own one native Job through its OS interface; callers supply platform bindings. */
export function createWindowsJobRunner(win, { resolveExecutable, environment = process.env }) {
  const JOB = { query: 4, terminate: 8, accounting: 1, limits: 9, killOnClose: 0x2000 };
  const PROCESS = { suspended: 4, unicodeEnvironment: 0x400, noWindow: 0x08000000 };
  const LAYOUT = { startup: 104, process: 24, limits: 144, accounting: 48 };
  const POLL_MS = 20;
  const wide = text => Buffer.from(`${text}\0`, 'utf16le');

  function jobNameBuffer(name) {
    if (!/^Local\\Nous-heavy-run-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(name))
      throw new Error('Invalid Windows lease Job name.');
    return wide(name);
  }

  function checked(result, operation) {
    if (!result) throw new Error(`Windows Job ${operation} failed (${win.GetLastError()}).`);
    return result;
  }

  function openJob(name, access) {
    const handle = win.OpenJobObjectW(access, 0, jobNameBuffer(name));
    if (handle) return handle;
    if (win.GetLastError() === 2) return null;
    throw new Error('Cannot open the Windows lease Job.');
  }

  function activeProcesses(handle) {
    const accounting = Buffer.alloc(LAYOUT.accounting);
    checked(
      win.QueryInformationJobObject(handle, JOB.accounting, accounting, accounting.length, null),
      'query'
    );
    return accounting.readUInt32LE(40);
  }

  function jobRunning(name) {
    const handle = openJob(name, JOB.query);
    if (!handle) return false;
    try {
      return activeProcesses(handle) > 0;
    } finally {
      win.CloseHandle(handle);
    }
  }

  async function waitForEmpty(handle) {
    if (activeProcesses(handle) === 0) return;
    for await (const job of ticks(POLL_MS, handle)) {
      if (activeProcesses(job) === 0) break;
    }
  }

  async function stopJob(name) {
    const handle = openJob(name, JOB.query | JOB.terminate);
    if (!handle) return;
    try {
      checked(win.TerminateJobObject(handle, 143), 'termination');
      await waitForEmpty(handle);
    } finally {
      win.CloseHandle(handle);
    }
  }

  function createJob(name) {
    const handle = checked(win.CreateJobObjectW(null, jobNameBuffer(name)), 'creation');
    try {
      if (win.GetLastError() === 183) throw new Error('Windows lease Job already exists.');
      const limits = Buffer.alloc(LAYOUT.limits);
      limits.writeUInt32LE(JOB.killOnClose, 16);
      checked(win.SetInformationJobObject(handle, JOB.limits, limits, limits.length), 'limits');
      return handle;
    } catch (error) {
      win.CloseHandle(handle);
      throw error;
    }
  }

  /** Encode argv using the Windows CRT backslash/quote rules, including empty arguments. */
  function quoteArgument(argument) {
    let quoted = '"';
    let backslashes = 0;
    for (const character of argument) {
      if (character === '\\') {
        backslashes++;
        continue;
      }
      quoted += '\\'.repeat(backslashes * (character === '"' ? 2 : 1));
      if (character === '"') quoted += '\\';
      quoted += character;
      backslashes = 0;
    }
    return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
  }

  function startupHandles(startup) {
    const inherited = [];
    try {
      // STARTF_USESTDHANDLES; preserve the wrapper's pipes and hidden console settings.
      startup.writeUInt32LE(0x100, 60);
      for (const [index, standard] of [0xfffffff6, 0xfffffff5, 0xfffffff4].entries()) {
        const handle = win.GetStdHandle(standard);
        const flags = Buffer.alloc(4);
        checked(win.GetHandleInformation(handle, flags), 'standard handle inspection');
        inherited.push([handle, flags.readUInt32LE()]);
        checked(win.SetHandleInformation(handle, 1, 1), 'standard handle inheritance');
        startup.writeBigUInt64LE(BigInt(handle), 80 + index * 8);
      }
      return inherited;
    } catch (error) {
      for (const [handle, flags] of inherited) win.SetHandleInformation(handle, 1, flags & 1);
      throw error;
    }
  }

  function spawnSuspended(command) {
    const executable = resolveExecutable(command[0]);
    if (!executable) throw new Error('Heavy command executable was not found.');
    const startup = Buffer.alloc(LAYOUT.startup);
    startup.writeUInt32LE(startup.length);
    const info = Buffer.alloc(LAYOUT.process);
    const inherited = startupHandles(startup);
    try {
      // Admission control and Bun's IPC descriptor belong only to the helper.
      const block = Object.entries(environment)
        .filter(
          ([key, value]) =>
            value !== undefined &&
            ![
              'NODE_CHANNEL_FD',
              'NODE_CHANNEL_SERIALIZATION_MODE',
              'HEAVY_RUN_WINDOWS_JOB',
            ].includes(key)
        )
        .sort(([left], [right]) => {
          const first = left.toUpperCase();
          const second = right.toUpperCase();
          return first < second ? -1 : Number(first > second);
        })
        .map(([key, value]) => `${key}=${value}`)
        .join('\0');
      checked(
        win.CreateProcessW(
          wide(executable),
          wide([executable, ...command.slice(1)].map(quoteArgument).join(' ')),
          null,
          null,
          1,
          PROCESS.suspended | PROCESS.unicodeEnvironment | PROCESS.noWindow,
          wide(`${block}\0`),
          null,
          startup,
          info
        ),
        'suspended process creation'
      );
      return { process: info.readBigUInt64LE(), thread: info.readBigUInt64LE(8) };
    } finally {
      for (const [handle, flags] of inherited) win.SetHandleInformation(handle, 1, flags & 1);
    }
  }

  async function executeJob(handle, child) {
    if (win.ResumeThread(child.thread) === 0xffffffff)
      throw new Error('Cannot resume the Windows lease command.');
    await waitForEmpty(handle);
    const code = Buffer.alloc(4);
    checked(win.GetExitCodeProcess(child.process, code), 'exit code');
    return code.readUInt32LE();
  }

  async function worker(name, idleMs, command, channel = process) {
    const handle = createJob(name);
    let child;
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      checked(win.TerminateJobObject(handle, 143), 'interruption');
    };
    channel.once('disconnect', stop);
    channel.once('SIGINT', stop);
    channel.once('SIGTERM', stop);
    try {
      // Publish only after assignment: an empty Job must never look like completed work.
      child = spawnSuspended(command);
      checked(win.AssignProcessToJobObject(handle, child.process), 'process assignment');
      const admitted = await new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), idleMs);
        channel.once('message', message => {
          clearTimeout(deadline);
          resolve(message === 'run');
        });
        channel.send('ready');
      });
      if (!admitted || cancelled) return 1;
      return await executeJob(handle, child);
    } finally {
      // Includes admission, assignment and resume failure while the root is suspended.
      if (child) win.TerminateProcess(child.process, 143);
      win.TerminateJobObject(handle, 143);
      await waitForEmpty(handle);
      if (child) {
        win.CloseHandle(child.thread);
        win.CloseHandle(child.process);
      }
      win.CloseHandle(handle);
      channel.removeListener('disconnect', stop);
      channel.removeListener('SIGINT', stop);
      channel.removeListener('SIGTERM', stop);
      if (channel.connected) channel.disconnect();
    }
  }

  return { jobRunning, stopJob, worker };
}
