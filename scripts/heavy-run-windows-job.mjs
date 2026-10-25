import { createWindowsJobRunner } from './heavy-run-windows-job-lifecycle.mjs';

if (process.platform !== 'win32' || !process.versions.bun)
  throw new Error('Native Windows Jobs require Bun on Windows.');
const { dlopen } = await import('bun:ffi');
// Win64 HANDLEs are integers, not addresses; Bun FFI requires u64 for them.
const { symbols: win } = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'u64' },
  OpenJobObjectW: { args: ['u32', 'i32', 'ptr'], returns: 'u64' },
  SetInformationJobObject: { args: ['u64', 'i32', 'ptr', 'u32'], returns: 'i32' },
  QueryInformationJobObject: { args: ['u64', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
  AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'i32' },
  TerminateJobObject: { args: ['u64', 'u32'], returns: 'i32' },
  CreateProcessW: {
    args: ['ptr', 'ptr', 'ptr', 'ptr', 'i32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'],
    returns: 'i32',
  },
  ResumeThread: { args: ['u64'], returns: 'u32' },
  TerminateProcess: { args: ['u64', 'u32'], returns: 'i32' },
  GetExitCodeProcess: { args: ['u64', 'ptr'], returns: 'i32' },
  GetStdHandle: { args: ['u32'], returns: 'u64' },
  GetHandleInformation: { args: ['u64', 'ptr'], returns: 'i32' },
  SetHandleInformation: { args: ['u64', 'u32', 'u32'], returns: 'i32' },
  CloseHandle: { args: ['u64'], returns: 'i32' },
  GetLastError: { args: [], returns: 'u32' },
});

const runner = createWindowsJobRunner(win, { resolveExecutable: Bun.which });
export const { jobRunning, stopJob } = runner;

if (import.meta.main) {
  try {
    const [mode, name, idleMs, separator, ...command] = process.argv.slice(2);
    if (mode === 'query') console.log(jobRunning(name));
    else if (mode === 'stop') await stopJob(name);
    else if (mode === 'worker' && separator === '--' && process.send)
      process.exitCode = await runner.worker(name, Number(idleMs), command);
    else throw new Error('Invalid Windows Job invocation.');
  } catch (error) {
    console.error(`heavy-run: ${error.message}`);
    process.exitCode = 1;
  }
}
