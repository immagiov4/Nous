import { afterEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: host.execute }) };
});

import { processIdentity } from '../processIdentity';

afterEach(() => host.execute.mockReset());

it('distinguishes Windows processes that reused a PID through their birth time', async () => {
  const original = { startedAt: '2026-10-20T10:00:00Z', command: 'proof-command' };
  const replacement = { ...original, startedAt: '2026-10-20T11:00:00Z' };
  host.execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(original) })
    .mockResolvedValueOnce({ stdout: JSON.stringify(replacement) });
  const first = await processIdentity(42, { platform: 'win32' });
  const second = await processIdentity(42, { platform: 'win32' });
  expect(first).toBe(JSON.stringify(original));
  expect(second).toBe(JSON.stringify(replacement));
  expect(first).not.toBe(second);
  expect(host.execute.mock.calls[0][2]).toMatchObject({ windowsHide: true });
});

it('reports a Windows process that has already exited as absent', async () => {
  host.execute.mockResolvedValue({ stdout: '' });
  expect(await processIdentity(42, { platform: 'win32' })).toBeUndefined();
});
it('keeps birth-only ownership stable when the command title changes', async () => {
  const startedAt = '2026-10-20T10:00:00Z';
  host.execute
    .mockResolvedValueOnce({ stdout: JSON.stringify({ startedAt, command: 'original-title' }) })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ startedAt, command: 'updated-title' }) })
    .mockResolvedValueOnce({ stdout: 'Tue Oct 20 10:00:00 2026\n' });
  expect(await processIdentity(42, { platform: 'win32', includeCommand: false })).toBe(startedAt);
  expect(await processIdentity(42, { platform: 'win32', includeCommand: false })).toBe(startedAt);
  expect(await processIdentity(42, { platform: 'linux', includeCommand: false })).toBe(
    'Tue Oct 20 10:00:00 2026'
  );
  expect(host.execute.mock.calls[2][1]).toEqual(['-ww', '-p', '42', '-o', 'lstart=']);
});

it('normalizes POSIX process identity in a stable locale', async () => {
  host.execute.mockResolvedValue({ stdout: '  Tue Oct 20 10:00:00 2026 proof-command\n' });
  expect(await processIdentity(42, { platform: 'linux' })).toBe(
    'Tue Oct 20 10:00:00 2026 proof-command'
  );
  expect(host.execute.mock.calls[0][2]).toMatchObject({
    windowsHide: true,
    env: expect.objectContaining({ LC_ALL: 'C' }),
  });
});

it('reports POSIX process-not-found without hiding inspection errors', async () => {
  host.execute
    .mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 1 }))
    .mockRejectedValueOnce(Object.assign(new Error('inspection denied'), { code: 5 }));
  expect(await processIdentity(42, { platform: 'linux' })).toBeUndefined();
  await expect(processIdentity(42, { platform: 'linux' })).rejects.toThrow('inspection denied');
});
