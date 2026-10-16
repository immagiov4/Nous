import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { privateFixtureSkipReason } from '../fixtures';

const story = { requires: { course: 'fixture:course-id' } };
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it('requires opt-in, blocks CI even with consent, and explains missing backups', async () => {
  vi.stubEnv('CI', '');
  vi.stubEnv('NOUS_E2E_PRIVATE_FIXTURES', '');
  expect(await privateFixtureSkipReason(story)).toBe(
    'Private course fixtures require NOUS_E2E_PRIVATE_FIXTURES=1.'
  );
  vi.stubEnv('NOUS_E2E_PRIVATE_FIXTURES', '1');
  vi.stubEnv('CI', 'true');
  expect(await privateFixtureSkipReason(story)).toBe('Private course fixtures never run in CI.');
  vi.stubEnv('CI', '');
  root = await mkdtemp(join(tmpdir(), 'private-fixtures-'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  expect(await privateFixtureSkipReason(story)).toBe(
    'Private course fixture backup is unavailable.'
  );
  await mkdir(join(root, 'fixtures'));
  await writeFile(
    join(root, 'fixtures', 'nous-library-backup.nous-library.zip'),
    'availability only'
  );
  expect(await privateFixtureSkipReason(story)).toBeUndefined();
  vi.stubEnv('NOUS_E2E_LIBRARY', 'other.zip');
  expect(await privateFixtureSkipReason(story)).toBe(
    'Private course fixture backup is unavailable.'
  );
  await writeFile(join(root, 'fixtures', 'course-id'), 'legacy fixture');
  expect(await privateFixtureSkipReason(story)).toBeUndefined();
});
it('applies private policy to course overrides while retaining synthetic and course-free stories', async () => {
  vi.stubEnv('CI', 'true');
  const synthetic = { requires: { course: 'synthetic-short' } };
  expect(await privateFixtureSkipReason(synthetic)).toBeUndefined();
  vi.stubEnv('NOUS_E2E_COURSE', 'fixture:course-id');
  expect(await privateFixtureSkipReason(synthetic)).toBe(
    'Private course fixtures never run in CI.'
  );
  expect(await privateFixtureSkipReason({ requires: {} })).toBeUndefined();
});
