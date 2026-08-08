import type { ProjectAssetRef, ProjectLessonVisual } from '@shared/projectAsset';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { fetchWithSupabaseAuth } from '../../../services/auth/supabaseAuth.ts';
import { resolveProjectVisual } from '../../../services/projects/projectVisualResolver.ts';
import type { LessonGeneratedVisual } from '../../../types.ts';

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: vi.fn(),
}));

const PROJECT_ID = 'project/with scope';
const bytes = new TextEncoder().encode('project asset');

const hashBytes = async (value: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const createAssetRef = async (idCharacter: string): Promise<ProjectAssetRef> => ({
  byteSize: bytes.byteLength,
  hash: await hashBytes(bytes),
  id: idCharacter.repeat(64),
  mediaType: 'image/png',
});

const createVisual = (render: ProjectLessonVisual['render']): ProjectLessonVisual => ({
  altText: 'Schema distribuito',
  createdAt: '2026-07-29T12:00:00.000Z',
  id: 'visual-1',
  render,
  slotId: 'slot-1',
  title: 'Schema',
});

const okAssetResponse = () =>
  new Response(bytes, { headers: { 'Content-Type': 'image/png' }, status: 200 });

describe('projectVisualResolver', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    createObjectURL.mockImplementation(() => `blob:asset-${createObjectURL.mock.calls.length}`);
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  test('returns a legacy visual without fetching or allocating a transient URL', async () => {
    const legacy: LessonGeneratedVisual = {
      code: '<svg></svg>',
      createdAt: '2026-07-29T12:00:00.000Z',
      id: 'legacy',
      kind: 'svg',
      title: 'Legacy',
    };

    const result = await resolveProjectVisual({
      projectId: null,
      signal: new AbortController().signal,
      visual: legacy,
    });

    expect(result.visual).toBe(legacy);
    expect(fetchWithSupabaseAuth).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('authenticates and verifies an image asset before exposing a transient URL', async () => {
    const asset = await createAssetRef('a');
    vi.mocked(fetchWithSupabaseAuth).mockResolvedValue(okAssetResponse());
    const controller = new AbortController();

    const result = await resolveProjectVisual({
      projectId: PROJECT_ID,
      signal: controller.signal,
      visual: createVisual({ asset, kind: 'image' }),
    });

    expect(fetchWithSupabaseAuth).toHaveBeenCalledWith(
      `http://127.0.0.1:3301/api/projects/project%2Fwith%20scope/assets/${asset.id}`,
      { signal: controller.signal }
    );
    expect(result.visual).toMatchObject({ code: 'blob:asset-1', kind: 'image' });
    expect(result.trustedImageUrl).toBe(true);

    result.release();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-1');
  });

  test('resolves every declared HTML placeholder and releases all allocated URLs', async () => {
    const first = await createAssetRef('a');
    const second = await createAssetRef('b');
    vi.mocked(fetchWithSupabaseAuth).mockImplementation(async () => okAssetResponse());

    const result = await resolveProjectVisual({
      projectId: PROJECT_ID,
      signal: new AbortController().signal,
      visual: createVisual({
        code: `<img src="{{PROJECT_ASSET:${first.id}}}"><img src="{{PROJECT_ASSET:${second.id}}}"><img src="{{PROJECT_ASSET:${first.id}}}">`,
        embeddedAssets: [first, second],
        kind: 'html',
      }),
    });

    expect(result.visual.code).toBe(
      '<img src="blob:asset-1"><img src="blob:asset-2"><img src="blob:asset-1">'
    );
    expect(fetchWithSupabaseAuth).toHaveBeenCalledTimes(2);

    result.release();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-2');
  });

  test('rejects mismatched HTML refs before making a request', async () => {
    const asset = await createAssetRef('a');

    await expect(
      resolveProjectVisual({
        projectId: PROJECT_ID,
        signal: new AbortController().signal,
        visual: createVisual({
          code: `<img src="{{PROJECT_ASSET:${'b'.repeat(64)}}}">`,
          embeddedAssets: [asset],
          kind: 'html',
        }),
      })
    ).rejects.toMatchObject({ code: 'visual-placeholder-invalid' });
    expect(fetchWithSupabaseAuth).not.toHaveBeenCalled();
  });

  test('rejects bytes that do not match the durable content hash', async () => {
    const asset = { ...(await createAssetRef('a')), hash: 'f'.repeat(64) };
    vi.mocked(fetchWithSupabaseAuth).mockResolvedValue(okAssetResponse());

    await expect(
      resolveProjectVisual({
        projectId: PROJECT_ID,
        signal: new AbortController().signal,
        visual: createVisual({ asset, kind: 'image' }),
      })
    ).rejects.toMatchObject({ code: 'asset-content-invalid' });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('releases already allocated URLs when a later allocation fails', async () => {
    const first = await createAssetRef('a');
    const second = await createAssetRef('b');
    vi.mocked(fetchWithSupabaseAuth).mockImplementation(async () => okAssetResponse());
    createObjectURL.mockReturnValueOnce('blob:first-asset').mockImplementationOnce(() => {
      throw new Error('URL allocation failed');
    });

    await expect(
      resolveProjectVisual({
        projectId: PROJECT_ID,
        signal: new AbortController().signal,
        visual: createVisual({
          code: `<img src="{{PROJECT_ASSET:${first.id}}}"><img src="{{PROJECT_ASSET:${second.id}}}">`,
          embeddedAssets: [first, second],
          kind: 'html',
        }),
      })
    ).rejects.toThrow('URL allocation failed');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first-asset');
  });
});
