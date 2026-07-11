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
      return commandResults.shift() ?? true;
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
});
