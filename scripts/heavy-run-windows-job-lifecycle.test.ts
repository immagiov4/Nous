import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createWindowsJobRunner } from './heavy-run-windows-job-lifecycle.mjs';

const NAME = String.raw`Local\Nous-heavy-run-00000000-0000-0000-0000-000000000001`;
afterEach(() => vi.useRealTimers());

/** Model the Win32 boundary; lifecycle/ABI logic remains the real implementation. */
function fixture() {
  const state = { active: 0, error: 5, assigned: false, resumed: false, exitCode: 7 };
  const win = {
    CreateJobObjectW: vi.fn(() => 10n),
    OpenJobObjectW: vi.fn((): bigint => 10n),
    SetInformationJobObject: vi.fn(() => 1),
    QueryInformationJobObject: vi.fn((_job, _kind, buffer: Buffer) => {
      buffer.writeUInt32LE(state.active, 40);
      return 1;
    }),
    AssignProcessToJobObject: vi.fn(() => {
      state.assigned = true;
      state.active = 1;
      return 1;
    }),
    TerminateJobObject: vi.fn(() => {
      state.active = 0;
      return 1;
    }),
    CreateProcessW: vi.fn(
      (_exe, _line, _process, _thread, _inherit, _flags, _env, _cwd, _startup, info: Buffer) => {
        info.writeBigUInt64LE(20n);
        info.writeBigUInt64LE(30n, 8);
        return 1;
      }
    ),
    ResumeThread: vi.fn(() => {
      if (!state.assigned) throw new Error('A root cannot run outside its Job.');
      state.resumed = true;
      return 1;
    }),
    TerminateProcess: vi.fn(() => {
      state.active = 0;
      return 1;
    }),
    GetExitCodeProcess: vi.fn((_process, code: Buffer) => {
      code.writeUInt32LE(state.exitCode);
      return 1;
    }),
    GetStdHandle: vi.fn((kind: number) => BigInt(kind)),
    GetHandleInformation: vi.fn((_handle, flags: Buffer) => {
      flags.writeUInt32LE(0);
      return 1;
    }),
    SetHandleInformation: vi.fn(() => 1),
    CloseHandle: vi.fn(() => 1),
    GetLastError: vi.fn(() => state.error),
  };
  const channel = Object.assign(new EventEmitter(), {
    connected: true,
    disconnect: vi.fn(() => {
      channel.connected = false;
    }),
    send: vi.fn((_message: string) => {
      channel.emit('message', 'run');
    }),
  });
  const resolveExecutable = vi.fn((): string | null => 'C:\\fixtures\\node.exe');
  const runner = createWindowsJobRunner(win, {
    resolveExecutable,
    environment: { HEAVY_RUN_HELD: '1', HEAVY_RUN_WINDOWS_JOB: NAME, NODE_CHANNEL_FD: '3' },
  });
  return { state, win, channel, runner, resolveExecutable };
}

test('native Job queries distinguish active members, completion, missing Jobs and inspection errors', () => {
  const { runner, state, win } = fixture();
  state.active = 3;
  expect(runner.jobRunning(NAME)).toBe(true);
  state.active = 0;
  expect(runner.jobRunning(NAME)).toBe(false);
  win.OpenJobObjectW.mockReturnValue(0n);
  state.error = 2;
  expect(runner.jobRunning(NAME)).toBe(false);
  state.error = 5;
  expect(() => runner.jobRunning(NAME)).toThrow('Cannot open');
  expect(() => runner.jobRunning('foreign-job')).toThrow('Invalid Windows lease Job name');
});

test('Job termination waits for zero native members and closes its query handle', async () => {
  const { runner, state, win } = fixture();
  state.active = 2;
  await runner.stopJob(NAME);
  expect(state.active).toBe(0);
  expect(win.TerminateJobObject.mock.calls).toEqual([[10n, 143]]);
  expect(win.CloseHandle.mock.calls).toEqual([[10n]]);
  win.OpenJobObjectW.mockReturnValue(0n);
  state.error = 2;
  await runner.stopJob(NAME);
  expect(win.TerminateJobObject.mock.calls).toEqual([[10n, 143]]);
});

test('failed termination and failed inspection propagate while closing opened handles', async () => {
  const { runner, win } = fixture();
  win.TerminateJobObject.mockReturnValue(0);
  await expect(runner.stopJob(NAME)).rejects.toThrow('termination failed (5)');
  win.QueryInformationJobObject.mockReturnValue(0);
  expect(() => runner.jobRunning(NAME)).toThrow('query failed (5)');
  expect(win.CloseHandle.mock.calls).toEqual([[10n], [10n]]);
});

test('worker assigns a suspended root before admission and holds descendants after root exit', async () => {
  vi.useFakeTimers();
  const { runner, channel, win, state } = fixture();
  channel.send.mockImplementation(message => {
    expect(message).toBe('ready');
    expect(state).toMatchObject({ assigned: true, resumed: false });
    channel.emit('message', 'run');
  });
  let settled = false;
  const running = runner
    .worker(NAME, 2000, ['node', 'two words', '', 'a"b', 'tail\\'], channel)
    .then(code => {
      settled = true;
      return code;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.resumed).toBe(true);
  expect(settled).toBe(false);
  const creation = win.CreateProcessW.mock.calls[0];
  expect(creation[5]).toBe(0x08000404);
  expect(creation[1].toString('utf16le')).toContain('"two words" ""');
  const environment = creation[6].toString('utf16le');
  expect(environment).toBe('HEAVY_RUN_HELD=1\0\0');
  expect(win.SetInformationJobObject.mock.calls[0][2].readUInt32LE(16)).toBe(0x2000);
  state.active = 0;
  await vi.advanceTimersByTimeAsync(20);
  expect(await running).toBe(7);
  expect(win.CloseHandle.mock.calls).toEqual([[30n], [20n], [10n]]);
  expect(channel.connected).toBe(false);
});

test.each([
  'disconnect',
  'SIGINT',
  'SIGTERM',
])('%s terminates active members and removes worker listeners', async signal => {
  vi.useFakeTimers();
  const { runner, channel, state } = fixture();
  const running = runner.worker(NAME, 2000, ['node'], channel);
  await vi.advanceTimersByTimeAsync(0);
  channel.emit(signal);
  await vi.advanceTimersByTimeAsync(20);
  expect(await running).toBe(7);
  expect(state.active).toBe(0);
  expect(channel.listenerCount(signal)).toBe(0);
});

test.each([
  'denied',
  'expired',
])('an %s admission never resumes its suspended command', async mode => {
  vi.useFakeTimers();
  const { runner, channel, state } = fixture();
  channel.send.mockImplementation(() => {
    if (mode === 'denied') channel.emit('message', 'deny');
  });
  const running = runner.worker(NAME, 2000, ['node'], channel);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await running).toBe(1);
  expect(state).toMatchObject({ resumed: false, active: 0 });
  expect(channel.connected).toBe(false);
});

test.each([
  'assignment',
  'resume',
  'creation',
  'limits',
  'existing',
  'executable',
  'stdio',
  'inheritance',
  'exit-code',
])('%s failure prevents unsafe execution and closes owned resources', async failure => {
  const { runner, channel, win, state, resolveExecutable } = fixture();
  if (failure === 'assignment') win.AssignProcessToJobObject.mockReturnValue(0);
  if (failure === 'resume') win.ResumeThread.mockReturnValue(0xffffffff);
  if (failure === 'creation') win.CreateProcessW.mockReturnValue(0);
  if (failure === 'limits') win.SetInformationJobObject.mockReturnValue(0);
  if (failure === 'existing') state.error = 183;
  if (failure === 'executable') resolveExecutable.mockReturnValue(null);
  if (failure === 'stdio') win.GetHandleInformation.mockReturnValue(0);
  if (failure === 'inheritance') win.SetHandleInformation.mockReturnValueOnce(0);
  if (failure === 'exit-code') {
    win.ResumeThread.mockImplementation(() => {
      state.active = 0;
      return 1;
    });
    win.GetExitCodeProcess.mockReturnValue(0);
  }
  await expect(runner.worker(NAME, 2000, ['node'], channel)).rejects.toThrow();
  expect(state.active).toBe(0);
  expect(win.CloseHandle.mock.calls.at(-1)).toEqual([10n]);
});

test('non-Bun runtimes reject the native adapter before loading Bun FFI', async () => {
  if (process.versions.bun) return;
  await expect(import('./heavy-run-windows-job.mjs')).rejects.toThrow('require Bun on Windows');
});
