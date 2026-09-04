// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  clearSupabaseSession();
});

afterEach(() => {
  document.getElementById('nous-native-download-frame')?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('HttpProjectRepository waits for a durable export before starting a native download', async () => {
  vi.useFakeTimers();
  const progress = vi.fn();
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  const running = {
    bytesWritten: 12,
    completedProjectCount: 1,
    correlationId: '550e8400-e29b-41d4-a716-446655440000',
    phase: 'project-archive',
    projectCount: 2,
    runId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    status: 'running',
  };
  const completed = {
    ...running,
    archiveBytes: 24,
    bytesWritten: 24,
    completedProjectCount: 2,
    phase: 'ready',
    status: 'completed',
  };
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ run: running, success: true }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ run: completed, success: true }),
    })
    .mockResolvedValueOnce({
      json: async () => ({ downloadToken: 'one-time-download-token', success: true }),
      ok: true,
      status: 200,
    });

  const repository = new HttpProjectRepository('http://localhost:3301');
  const pendingExport = repository.exportLibraryBackup(progress);
  await vi.runAllTimersAsync();

  await expect(pendingExport).resolves.toEqual({ projectCount: 2 });
  expect(progress).toHaveBeenNthCalledWith(1, running);
  expect(progress).toHaveBeenNthCalledWith(2, completed);
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    'http://localhost:3301/api/projects/library-exports',
    'http://localhost:3301/api/projects/library-exports/6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    'http://localhost:3301/api/projects/library-exports/6ba7b810-9dad-11d1-80b4-00c04fd430c8/download-access',
  ]);
  expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' });
  expect(submit).toHaveBeenCalledOnce();
  const form = submit.mock.instances[0] as HTMLFormElement;
  expect(form.action).toBe(
    'http://localhost:3301/api/projects/library-exports/6ba7b810-9dad-11d1-80b4-00c04fd430c8/download'
  );
  expect(form.method).toBe('post');
  expect(form.target).toBe('nous-native-download-frame');
  expect((form.elements.namedItem('downloadToken') as HTMLInputElement).value).toBe(
    'one-time-download-token'
  );
});
