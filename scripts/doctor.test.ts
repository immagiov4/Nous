import { describe, expect, test } from 'vitest';
import {
  inspectEnvironment,
  parseCiBunVersions,
  parseDoctorArguments,
  parseFallowBaseline,
  parseMigrationList,
  parsePinnedBunVersion,
  resolveLocalSupabaseConfig,
} from './doctor';

describe('parseDoctorArguments', () => {
  test('uses service-free checks by default', () => {
    expect(parseDoctorArguments([])).toBe('checks');
  });

  test.each([
    { arguments_: ['--profile', 'gate'], expected: 'gate' },
    { arguments_: ['--profile=local'], expected: 'local' },
    { arguments_: ['--profile', 'all'], expected: 'all' },
  ] as const)('selects the $expected profile', ({ arguments_, expected }) => {
    expect(parseDoctorArguments(arguments_)).toBe(expected);
  });

  test('rejects unsupported arguments', () => {
    expect(() => parseDoctorArguments(['--json'])).toThrow();
  });
});

describe('parsePinnedBunVersion', () => {
  test('returns the exact Bun version from packageManager', () => {
    expect(parsePinnedBunVersion(JSON.stringify({ packageManager: 'bun@1.3.14' }))).toBe('1.3.14');
  });

  test.each([
    '{}',
    JSON.stringify({ packageManager: 'npm@11.0.0' }),
  ])('rejects a manifest without a pinned Bun runtime: %s', manifest => {
    expect(() => parsePinnedBunVersion(manifest)).toThrow();
  });
});

describe('parseCiBunVersions', () => {
  test('returns distinct pinned versions in stable order', () => {
    expect(
      parseCiBunVersions('bun-version: 1.3.14\nbun-version: 1.3.13\nbun-version: 1.3.14')
    ).toEqual(['1.3.13', '1.3.14']);
  });

  test('rejects a workflow without a Bun pin', () => {
    expect(() => parseCiBunVersions('name: CI')).toThrow();
  });
});

describe('parseFallowBaseline', () => {
  test('returns non-zero categories in stable debt-first order', () => {
    expect(
      parseFallowBaseline(
        JSON.stringify({
          check: {
            total_issues: 7,
            unused_dependencies: 2,
            unused_exports: 2,
            unused_files: 3,
            unused_types: 0,
          },
        })
      )
    ).toEqual({
      categories: [
        { count: 3, name: 'unused files' },
        { count: 2, name: 'unused dependencies' },
        { count: 2, name: 'unused exports' },
      ],
      totalIssues: 7,
    });
  });

  test.each([
    '{}',
    JSON.stringify({ check: {} }),
    JSON.stringify({ check: { total_issues: -1 } }),
    JSON.stringify({ check: { total_issues: 1.5 } }),
    JSON.stringify({ check: { total_issues: 1, unused_files: -1 } }),
  ])('rejects an invalid regression baseline: %s', baseline => {
    expect(() => parseFallowBaseline(baseline)).toThrow();
  });
});

describe('parseMigrationList', () => {
  test('reports migration drift deterministically', () => {
    expect(
      parseMigrationList(
        JSON.stringify({
          migrations: [
            { local: '20260101000000', remote: '20260101000000' },
            { local: '20260102000000' },
          ],
        })
      )
    ).toEqual({
      driftedMigrations: ['local=20260102000000, database=-'],
      totalMigrations: 2,
    });
  });

  test('rejects output without migrations', () => {
    expect(() => parseMigrationList('{}')).toThrow();
  });
});

describe('resolveLocalSupabaseConfig', () => {
  test('accepts a coherent loopback configuration', () => {
    expect(
      resolveLocalSupabaseConfig({
        SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_ANON_KEY: 'local-key',
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      })
    ).toMatchObject({ kind: 'ready' });
  });

  test.each([
    {
      SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'local-key',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
    },
    {
      SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'local-key',
      VITE_SUPABASE_URL: 'http://localhost:54321',
    },
  ])('rejects unsafe or incoherent local configuration', environment => {
    expect(resolveLocalSupabaseConfig(environment)).toMatchObject({ kind: 'invalid' });
  });
});

describe('inspectEnvironment', () => {
  test('finds the installed tools required by every Doctor profile', () => {
    const options = { bunVersion: '1.3.14', findExecutable: () => 'uvx' };
    expect(inspectEnvironment('all', options)).toEqual([
      expect.objectContaining({ label: 'Bun runtime', status: 'PASS' }),
      expect.objectContaining({ label: 'Workspace dependencies', status: 'PASS' }),
      expect.objectContaining({ label: 'uvx runtime', status: 'PASS' }),
      expect.objectContaining({ label: 'Fallow baseline', status: 'WARN' }),
    ]);
    expect(inspectEnvironment('gate', options)).toEqual([
      expect.objectContaining({ label: 'Bun runtime', status: 'PASS' }),
      expect.objectContaining({ label: 'Workspace dependencies', status: 'PASS' }),
    ]);
  });
});
