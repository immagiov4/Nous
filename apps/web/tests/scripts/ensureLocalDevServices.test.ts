import { describe, expect, test } from 'vitest';

import {
  ensureLocalDevServices,
  type LocalDevServicesRuntime,
} from '../../../../scripts/ensure-local-dev-services';

const createRuntime = (commandResults: boolean[], platform: NodeJS.Platform = 'win32') => {
  const commands: string[][] = [];
  const healthRequests: string[] = [];
  const runtime: LocalDevServicesRuntime = {
    platform,
    run: async command => {
      commands.push([...command]);
      return (commandResults.shift() ?? true) ? null : `failed: ${command.join(' ')}`;
    },
    requestHealth: async url => {
      healthRequests.push(url);
      return true;
    },
    writeStatus: () => {},
  };
  return { commands, healthRequests, runtime };
};

describe('ensureLocalDevServices', () => {
  test('starts and verifies the local Docker and Supabase dependencies in order', async () => {
    const { commands, healthRequests, runtime } = createRuntime([
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);

    await ensureLocalDevServices(
      {
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        SUPABASE_URL: 'http://127.0.0.1:54321',
      },
      runtime
    );

    expect(commands).toEqual([
      ['docker', 'info'],
      ['docker', 'desktop', 'start', '--timeout', '120'],
      ['docker', 'info'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
      ['bun', 'run', 'scripts/migrate-project-sources-to-storage.ts'],
      ['bunx', 'supabase', 'migration', 'up', '--local', '--yes'],
    ]);
    expect(healthRequests).toEqual(['http://127.0.0.1:54321/auth/v1/health']);
  });

  test('does not touch local infrastructure for remote-only configuration', async () => {
    const { commands, healthRequests, runtime } = createRuntime([]);

    await ensureLocalDevServices(
      {
        DATABASE_URL: 'postgresql://postgres:secret@db.example.com:5432/postgres',
        SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
      },
      runtime
    );

    expect(commands).toEqual([]);
    expect(healthRequests).toEqual([]);
  });

  test('does not continue to Supabase when Docker cannot be started', async () => {
    const { commands, runtime } = createRuntime([false, false]);

    await expect(
      ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime)
    ).rejects.toBeInstanceOf(Error);
    expect(commands).toEqual([
      ['docker', 'info'],
      ['docker', 'desktop', 'start', '--timeout', '120'],
    ]);
  });

  test('applies pending migrations when local Supabase is already running', async () => {
    const { commands, runtime } = createRuntime([true, true, true]);

    await ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime);

    expect(commands).toEqual([
      ['docker', 'info'],
      ['bunx', 'supabase', 'status'],
      ['bun', 'run', 'scripts/migrate-project-sources-to-storage.ts'],
      ['bunx', 'supabase', 'migration', 'up', '--local', '--yes'],
    ]);
  });

  test('accepts a healthy stack when supabase start exits with an error', async () => {
    const { commands, runtime } = createRuntime([true, false, false, true, true]);

    await ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime);

    expect(commands).toEqual([
      ['docker', 'info'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
      ['bun', 'run', 'scripts/migrate-project-sources-to-storage.ts'],
      ['bunx', 'supabase', 'migration', 'up', '--local', '--yes'],
    ]);
  });

  test('reports the real supabase start failure', async () => {
    const { commands, runtime } = createRuntime([true, false, false, false, true, false, false]);

    await expect(
      ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime)
    ).rejects.toThrow('Local Supabase could not be started after recovery');
    expect(commands).toEqual([
      ['docker', 'info'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'stop'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
    ]);
  });

  test('recovers an incomplete Supabase stack without deleting its data volume', async () => {
    const { commands, runtime } = createRuntime([
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);

    await ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime);

    expect(commands).toEqual([
      ['docker', 'info'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
      ['bunx', 'supabase', 'stop'],
      ['bunx', 'supabase', 'start', '--yes'],
      ['bunx', 'supabase', 'status'],
      ['bun', 'run', 'scripts/migrate-project-sources-to-storage.ts'],
      ['bunx', 'supabase', 'migration', 'up', '--local', '--yes'],
    ]);
  });

  test('reports a failed recovery before retrying the stack', async () => {
    const { commands, runtime } = createRuntime([true, false, false, false, false]);

    await expect(
      ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime)
    ).rejects.toThrow('Local Supabase could not be recovered');
    expect(commands.at(-1)).toEqual(['bunx', 'supabase', 'stop']);
  });

  test('stops startup when pending migrations cannot be applied', async () => {
    const { healthRequests, runtime } = createRuntime([true, true, true, false]);

    await expect(
      ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime)
    ).rejects.toThrow('Local Supabase migrations could not be applied');
    expect(healthRequests).toEqual([]);
  });

  test('stops startup when source objects cannot be staged before cutover', async () => {
    const { healthRequests, runtime } = createRuntime([true, true, false]);

    await expect(
      ensureLocalDevServices({ SUPABASE_URL: 'http://localhost:54321' }, runtime)
    ).rejects.toThrow('Local project sources could not be staged');
    expect(healthRequests).toEqual([]);
  });
});
