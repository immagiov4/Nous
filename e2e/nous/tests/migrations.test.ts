import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeIsolatedDatabase, migrationFingerprint, mirrorMigrations } from '../stack';

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'nous-migrations-'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  const source = join(root, 'repository-migrations');
  await mkdir(source);
  await writeFile(join(source, '002.sql'), 'select 2;');
  await writeFile(join(source, '001.sql'), 'select 1;');
  return source;
}
it('hashes sorted names and contents, including edits, additions, renames and deletions', async () => {
  const source = await fixture();
  const original = await migrationFingerprint(source);
  await rm(join(source, '001.sql'));
  await writeFile(join(source, '001.sql'), 'select 1;');
  expect(await migrationFingerprint(source)).toBe(original);
  await writeFile(join(source, '001.sql'), 'select 3;');
  expect(await migrationFingerprint(source)).not.toBe(original);
  const edited = await migrationFingerprint(source);
  await rename(join(source, '001.sql'), join(source, '003.sql'));
  expect(await migrationFingerprint(source)).not.toBe(edited);
  const renamed = await migrationFingerprint(source);
  await writeFile(join(source, '004.sql'), 'select 4;');
  expect(await migrationFingerprint(source)).not.toBe(renamed);
  await rm(join(source, '004.sql'));
  expect(await migrationFingerprint(source)).toBe(renamed);
});
it('mirrors exactly and removes stale files, committing the fingerprint only after apply', async () => {
  const source = await fixture();
  const destination = join(root, 'stack', 'supabase', 'migrations');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'stale.sql'), 'stale');
  const mirrored = await mirrorMigrations(source);
  expect((await readdir(destination)).sort()).toEqual(['001.sql', '002.sql']);
  expect(await readFile(join(destination, '001.sql'), 'utf8')).toBe('select 1;');
  expect(mirrored.changed).toBe(true);
  await expect(readFile(mirrored.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(mirrored.marker, mirrored.fingerprint);
  expect((await mirrorMigrations(source)).changed).toBe(false);
});
it('resets only a changed identity-verified isolated database and preserves the marker on failure', async () => {
  const migrations = await fixture();
  const status = {
    API_URL: 'http://127.0.0.1:55321',
    DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
    ANON_KEY: 'test',
    SERVICE_ROLE_KEY: 'test',
    JWT_SECRET: 'test',
  };
  const command = vi.fn(async (args: string[]) =>
    args[0] === 'status' ? JSON.stringify(status) : ''
  );
  await initializeIsolatedDatabase({ migrations, command });
  expect(command.mock.calls.map(([args]) => args)).toEqual([
    ['start'],
    ['status', '--output', 'json'],
    ['db', 'reset', '--local'],
    ['migration', 'up', '--local'],
  ]);
  command.mockClear();
  await initializeIsolatedDatabase({ migrations, command });
  expect(command.mock.calls.map(([args]) => args)).not.toContainEqual(['db', 'reset', '--local']);
  const marker = join(root, 'stack', 'migrations.sha256');
  const previous = await readFile(marker, 'utf8');
  await writeFile(join(migrations, '001.sql'), 'select 9;');
  command.mockImplementation(async args => {
    if (args[0] === 'db') throw new Error('Reset failed');
    return args[0] === 'status' ? JSON.stringify(status) : '';
  });
  await expect(initializeIsolatedDatabase({ migrations, command })).rejects.toThrow('Reset failed');
  expect(await readFile(marker, 'utf8')).toBe(previous);
  command.mockClear();
  command.mockResolvedValue(JSON.stringify({ ...status, API_URL: 'http://127.0.0.1:54321' }));
  await expect(initializeIsolatedDatabase({ migrations, command })).rejects.toThrow(
    'isolated playtest'
  );
  expect(command.mock.calls.map(([args]) => args)).not.toContainEqual(['db', 'reset', '--local']);
});

it('replaces an old generated config only after validating the isolated identity', async () => {
  const migrations = await fixture();
  const status = {
    API_URL: 'http://127.0.0.1:55321',
    DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
    ANON_KEY: 'test',
    SERVICE_ROLE_KEY: 'test',
    JWT_SECRET: 'test',
  };
  const command = vi.fn(async (args: string[]) =>
    args[0] === 'status' ? JSON.stringify(status) : ''
  );
  await initializeIsolatedDatabase({ migrations, command });
  const path = join(root, 'stack', 'supabase', 'config.toml');
  const generated = await readFile(path, 'utf8');
  await writeFile(
    path,
    generated.replace('site_url = "http://localhost:5173"', 'site_url = "http://localhost:9999"') +
      '\n# Previous repository generation\n'
  );
  await initializeIsolatedDatabase({ migrations, command });
  expect(await readFile(path, 'utf8')).toBe(generated);
  command.mockClear();
  const foreign = generated.replace(
    'project_id = "nous-playtest"',
    'project_id = "developer-project"'
  );
  await writeFile(path, foreign);
  await expect(initializeIsolatedDatabase({ migrations, command })).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(foreign);
});
