import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import type { ProjectAssetReader } from '../../src/projects/projectAssetReader.js';

const PROJECT_ID = 'project-1';
const ASSET_ID = 'a'.repeat(64);

const createReader = (): ProjectAssetReader => ({
  readActive: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([137, 80, 78, 71]),
    mediaType: 'image/png',
  }),
});

describe('GET /api/projects/:projectId/assets/:assetId', () => {
  test('reports a stable unavailable response for an explicitly uncomposed app factory', async () => {
    const response = await request(createApp()).get(
      `/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'project_asset_reader_unavailable',
      error: 'Servizio risorse del progetto non disponibile.',
      success: false,
    });
  });

  test('streams an active asset only through its authenticated project scope', async () => {
    const reader = createReader();

    const response = await request(createApp({ projectAssetReader: reader })).get(
      `/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(response.body)).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(reader.readActive).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      projectId: PROJECT_ID,
      userId: 'local-user',
    });
  });

  test('does not reveal whether an asset exists outside the authenticated scope', async () => {
    const reader = createReader();
    vi.mocked(reader.readActive).mockResolvedValue(null);

    const response = await request(createApp({ projectAssetReader: reader })).get(
      `/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'project_asset_not_found',
      error: 'Risorsa del progetto non trovata.',
      success: false,
    });
  });

  test('rejects malformed asset identities before accessing storage', async () => {
    const reader = createReader();

    const response = await request(createApp({ projectAssetReader: reader })).get(
      `/api/projects/${PROJECT_ID}/assets/not-an-asset-id`
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'project_asset_request_invalid',
      error: 'Richiesta della risorsa non valida.',
      success: false,
    });
    expect(reader.readActive).not.toHaveBeenCalled();
  });

  test('returns a stable error without exposing storage diagnostics', async () => {
    const reader = createReader();
    vi.mocked(reader.readActive).mockRejectedValue(new Error('private object storage path'));

    const response = await request(createApp({ projectAssetReader: reader })).get(
      `/api/projects/${PROJECT_ID}/assets/${ASSET_ID}`
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'project_asset_read_failed',
      error: 'Risorsa del progetto non disponibile.',
      success: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('private object storage path');
  });
});
