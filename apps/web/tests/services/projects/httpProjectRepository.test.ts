import assert from 'node:assert/strict';
import { beforeEach, expect, test, vi } from 'vitest';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  clearSupabaseSession();
});

test('HttpProjectRepository sends the Supabase bearer token to the backend', async () => {
  saveSupabaseSession({ accessToken: 'access-token-123' });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      success: true,
      folders: [],
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.listFolders();

  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(requestInit?.headers).toMatchObject({
    Authorization: 'Bearer access-token-123',
  });
});

test('HttpProjectRepository preserves backend errors instead of reporting server as unavailable', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    statusText: 'Unauthorized',
    json: async () => ({
      success: false,
      error: 'Autenticazione non configurata per questa installazione.',
    }),
  });

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message === 'Autenticazione non configurata per questa installazione.'
  );
});

test('HttpProjectRepository only uses the server unavailable message for network failures', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'Sincronizzazione server non disponibile. Verifica che il backend sia acceso e raggiungibile.'
  );
});

test('HttpProjectRepository reports request timeouts without claiming the backend is offline', async () => {
  fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'La sincronizzazione sta impiegando troppo tempo. Il backend e raggiungibile, ma non ha completato la richiesta.'
  );
});

test('HttpProjectRepository refreshes once and retries a backend 401', async () => {
  saveSupabaseSession({
    accessToken: 'access-token-old',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token-old',
  });
  fetchMock
    .mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ success: false, error: 'Sessione scaduta.' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-token-new',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-new',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, folders: [] }),
    });

  const repository = new HttpProjectRepository('http://localhost:3301');
  await repository.listFolders();

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer access-token-new',
  });
});
