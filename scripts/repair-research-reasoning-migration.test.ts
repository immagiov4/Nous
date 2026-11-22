import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { runMigrationRepair } from './repair-research-reasoning-migration.ts';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('postgres', () => ({ default: connect }));
const databaseUrl = 'postgresql://127.0.0.1/nous';

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

test('a fresh database without a migration ledger needs no repair', async () => {
  const sql = Object.assign(vi.fn().mockResolvedValue([{ exists: false }]), { end: vi.fn() });
  connect.mockReturnValue(sql);

  await expect(runMigrationRepair(databaseUrl)).resolves.toBe(0);
  expect(sql).toHaveBeenCalledTimes(1);
  expect(sql.end).toHaveBeenCalledOnce();
});

test.each([
  { description: 'July was inserted', inserted: [{ version: '20260728120000' }], logged: 1 },
  { description: 'the ledger already agrees', inserted: [], logged: 0 },
])('reports the repair outcome when $description', async ({ inserted, logged }) => {
  const sql = Object.assign(
    vi
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce(inserted),
    { end: vi.fn() }
  );
  connect.mockReturnValue(sql);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  await expect(runMigrationRepair(databaseUrl)).resolves.toBe(0);
  expect(log).toHaveBeenCalledTimes(logged);
  expect(sql.end).toHaveBeenCalledOnce();
});

test('missing configuration fails before opening a connection', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(runMigrationRepair(undefined)).resolves.toBe(1);
  expect(connect).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});

test('database errors close the connection and produce a safe diagnostic', async () => {
  const password = 'synthetic-error-password';
  const sql = Object.assign(vi.fn().mockRejectedValue(new Error(password)), { end: vi.fn() });
  connect.mockReturnValue(sql);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(runMigrationRepair(databaseUrl)).resolves.toBe(1);
  expect(sql.end).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  expect(error.mock.calls.flat().join(' ')).not.toContain(password);
});

test('migration repair fails without printing credentials from an invalid database URL', () => {
  const password = 'synthetic-migration-password';
  const result = spawnSync('bun', ['run', 'supabase:repair-research-reasoning-migration'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:invalid-port/nous`,
    },
    windowsHide: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Check DATABASE_URL');
  expect(result.stdout + result.stderr).not.toContain(password);
});
