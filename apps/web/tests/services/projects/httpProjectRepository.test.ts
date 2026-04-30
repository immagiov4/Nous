import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

test('HttpProjectRepository preserves backend errors instead of reporting LAN as unavailable', async () => {
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

test('HttpProjectRepository only uses the LAN unavailable message for network failures', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

  const repository = new HttpProjectRepository('http://localhost:3301');

  await assert.rejects(
    () => repository.listFolders(),
    (error: unknown) =>
      error instanceof ProjectStorageError &&
      error.message ===
        'Sincronizzazione LAN non disponibile. Verifica che il backend sia acceso e raggiungibile.'
  );
});
