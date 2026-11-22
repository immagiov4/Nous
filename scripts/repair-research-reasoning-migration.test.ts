import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

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
