import type { ProjectAssetRef } from '@shared/projectAsset';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { fetchWithSupabaseAuth } from '../../../services/auth/supabaseAuth.ts';
import { downloadProjectAssetBytes } from '../../../services/projects/projectAssetClient.ts';

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: vi.fn(),
}));

const PROJECT_ID = 'project/with scope';
const bytes = new TextEncoder().encode('project asset');

const hashBytes = async (value: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const createAssetRef = async (): Promise<ProjectAssetRef> => ({
  byteSize: bytes.byteLength,
  hash: await hashBytes(bytes),
  id: 'a'.repeat(64),
  mediaType: 'image/png',
});

describe('projectAssetClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('authenticates and verifies project asset bytes', async () => {
    const ref = await createAssetRef();
    const signal = new AbortController().signal;
    vi.mocked(fetchWithSupabaseAuth).mockResolvedValue(
      new Response(bytes, { headers: { 'Content-Type': 'image/png; charset=binary' }, status: 200 })
    );

    await expect(downloadProjectAssetBytes(PROJECT_ID, ref, signal)).resolves.toEqual(bytes);
    expect(fetchWithSupabaseAuth).toHaveBeenCalledWith(
      `http://127.0.0.1:3301/api/projects/project%2Fwith%20scope/assets/${ref.id}`,
      { signal }
    );
  });

  test('rejects an invalid durable reference before making a request', async () => {
    const ref = { ...(await createAssetRef()), id: '../asset' };

    await expect(downloadProjectAssetBytes(PROJECT_ID, ref)).rejects.toMatchObject({
      code: 'asset-reference-invalid',
    });
    expect(fetchWithSupabaseAuth).not.toHaveBeenCalled();
  });

  test('rejects bytes that do not match the durable reference', async () => {
    const ref = { ...(await createAssetRef()), hash: 'f'.repeat(64) };
    vi.mocked(fetchWithSupabaseAuth).mockResolvedValue(
      new Response(bytes, { headers: { 'Content-Type': 'image/png' }, status: 200 })
    );

    await expect(downloadProjectAssetBytes(PROJECT_ID, ref)).rejects.toMatchObject({
      code: 'asset-content-invalid',
    });
  });
});
