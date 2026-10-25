import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  processIdentity,
  processRunning,
  processTreeRunning,
  stopChild,
} from './heavy-run-process.mjs';

const { spawnMock, queryMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), queryMock: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: queryMock,
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (!platformDescriptor) throw new Error('The process platform must exist.');

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

test('Windows creation identity distinguishes an exited PID and propagates inspection failures', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:/Windows');
  queryMock
    .mockReturnValueOnce({ status: 0, stdout: '639285235716555915\r\n' })
    .mockReturnValueOnce({ status: 0, stdout: '' })
    .mockReturnValueOnce({ status: 1, stdout: '' });
  expect(processIdentity(424242)).toBe('639285235716555915');
  expect(queryMock.mock.calls[0][1]).toEqual(
    expect.arrayContaining([expect.stringContaining('GetProcessById(424242)')])
  );
  expect(queryMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  expect(processIdentity(424242)).toBeNull();
  expect(() => processIdentity(424242)).toThrow('Cannot inspect');
  expect(() => processIdentity(0)).toThrow('Invalid lease process identifier');
});

test('Windows release waits for taskkill completion and rejects a failed live-tree termination', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:/Windows');
  const killer = new EventEmitter();
  spawnMock.mockReturnValue(killer);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  let settled = false;
  const stopping = stopChild({ pid: 424242, exitCode: null, signalCode: null }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(spawnMock.mock.calls[0][1]).toEqual(['/pid', '424242', '/T', '/F']);
  expect(spawnMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  killer.emit('exit', 0);
  await stopping;
  expect(processRunning(424242)).toBe(false);
  kill.mockReturnValue(true);
  const failed = stopChild({ pid: 424242, exitCode: null, signalCode: null });
  killer.emit('exit', 1);
  await expect(failed).rejects.toThrow('Failed to stop');
});

test('POSIX release holds capacity until running group members exit and ignores zombies', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.useFakeTimers();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  queryMock
    .mockReturnValueOnce({ status: 0, stdout: '42 Z\n42 S\n99 R' })
    .mockReturnValue({ status: 0, stdout: '42 Z\n99 R' });
  let settled = false;
  const stopping = stopChild({ pid: 42, exitCode: null, signalCode: null }, 42).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL');
  expect(settled).toBe(false);
  await vi.runAllTimersAsync();
  await stopping;
  expect(processTreeRunning(42)).toBe(false);
  expect(processTreeRunning(99)).toBe(true);
});

test('POSIX creation identity comes from the OS and permission errors preserve liveness', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  queryMock.mockReturnValue({ status: 0, stdout: 'Sun Oct 25 12:00:00 2026\n' });
  expect(processIdentity(42)).toBe('Sun Oct 25 12:00:00 2026');
  expect(queryMock.mock.calls[0][1]).toEqual(['-p', '42', '-o', 'lstart=']);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('permission'), { code: 'EPERM' });
  });
  expect(processRunning(42)).toBe(true);
});
