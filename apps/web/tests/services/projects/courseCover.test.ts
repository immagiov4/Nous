import { beforeEach, describe, expect, test, vi } from 'vitest';
import { callOpenRouter } from '../../../services/openrouter/client.ts';
import { requestGeneratedImage } from '../../../services/openrouter/imageClient.ts';
import {
  ensureProjectCover,
  getProjectCoverDataUrl,
} from '../../../services/projects/courseCover.ts';

vi.mock('../../../services/openrouter/imageClient.ts', () => ({
  requestGeneratedImage: vi.fn(),
}));
vi.mock('../../../services/openrouter/client.ts', () => ({
  callOpenRouter: vi.fn(),
}));

const callOpenRouterMock = vi.mocked(callOpenRouter);
const requestGeneratedImageMock = vi.mocked(requestGeneratedImage);

describe('course covers', () => {
  const optimizeCover = vi.fn(async () => 'data:image/webp;base64,b3B0aW1pemVk');

  beforeEach(() => {
    callOpenRouterMock.mockReset();
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        subject: 'A cutaway model of a suspension bridge under load',
        composition: 'Low three-quarter view with the bridge deck crossing the frame diagonally',
        distinctiveDetails:
          'Visible tension cables, force arrows made from physical brass rods, and a cracked test beam',
      })
    );
    requestGeneratedImageMock.mockReset();
    optimizeCover.mockClear();
  });

  test('returns an existing stored cover without generating another image', async () => {
    const loadCover = vi.fn(async () => ({
      data: 'c3RvcmVk',
      mimeType: 'image/webp',
      name: 'project-stored-cover-v3.webp',
    }));
    const saveCover = vi.fn();

    const dataUrl = await ensureProjectCover({
      loadCover,
      projectId: 'project-stored',
      saveCover,
      title: 'Stored course',
    });

    expect(dataUrl).toBe('data:image/webp;base64,c3RvcmVk');
    expect(callOpenRouterMock).not.toHaveBeenCalled();
    expect(requestGeneratedImageMock).not.toHaveBeenCalled();
    expect(saveCover).not.toHaveBeenCalled();
    expect(optimizeCover).not.toHaveBeenCalled();
  });

  test('shares one generation while the same missing cover is requested twice', async () => {
    requestGeneratedImageMock.mockResolvedValue({
      dataUrl: 'data:image/png;base64,Z2VuZXJhdGVk',
      mediaType: 'image/png',
    });
    const loadCover = vi.fn(async () => null);
    const saveCover = vi.fn(async () => {});
    const request = {
      loadCover,
      optimizeCover,
      projectId: 'project-missing',
      saveCover,
      title: 'Distributed systems',
    };

    const [firstUrl, secondUrl] = await Promise.all([
      ensureProjectCover(request),
      ensureProjectCover(request),
    ]);

    expect(firstUrl).toBe('data:image/webp;base64,b3B0aW1pemVk');
    expect(secondUrl).toBe(firstUrl);
    expect(requestGeneratedImageMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSlot: 'assessment',
      })
    );
    expect(requestGeneratedImageMock).toHaveBeenCalledWith(
      expect.stringContaining('A cutaway model of a suspension bridge under load')
    );
    expect(saveCover).toHaveBeenCalledWith('project-missing', {
      data: 'b3B0aW1pemVk',
      mimeType: 'image/webp',
      name: 'project-missing-cover-v3.webp',
    });
  });

  test('uses short project context while planning a specific visual direction', async () => {
    requestGeneratedImageMock.mockResolvedValue({
      dataUrl: 'data:image/webp;base64,Y292ZXI=',
      mediaType: 'image/webp',
    });

    await ensureProjectCover({
      context: 'Source: structural-mechanics.pdf. Source kind: document.',
      loadCover: vi.fn(async () => null),
      optimizeCover,
      projectId: 'project-context',
      saveCover: vi.fn(async () => {}),
      title: 'Structural mechanics',
    });

    expect(callOpenRouterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('structural-mechanics.pdf'),
          }),
        ]),
      })
    );
  });

  test('compresses an existing v2 cover without regenerating it', async () => {
    let storedCover = {
      data: 'djJjb3Zlcg==',
      mimeType: 'image/png',
      name: 'project-refresh-cover-v2.png',
    };
    const loadCover = vi.fn(async () => storedCover);
    const saveCover = vi.fn(async (_projectId: string, cover: typeof storedCover) => {
      storedCover = cover;
    });
    const request = {
      loadCover,
      optimizeCover,
      projectId: 'project-refresh',
      saveCover,
      title: 'Applied thermodynamics',
    };

    const refreshedUrl = await ensureProjectCover(request);
    const reusedUrl = await ensureProjectCover(request);

    expect(refreshedUrl).toBe('data:image/webp;base64,b3B0aW1pemVk');
    expect(reusedUrl).toBe(refreshedUrl);
    expect(optimizeCover).toHaveBeenCalledWith('data:image/png;base64,djJjb3Zlcg==');
    expect(callOpenRouterMock).not.toHaveBeenCalled();
    expect(requestGeneratedImageMock).not.toHaveBeenCalled();
    expect(saveCover).toHaveBeenCalledTimes(1);
  });

  test('does not build a data URL for an empty file', () => {
    expect(getProjectCoverDataUrl({ data: '', mimeType: 'image/png', name: 'empty.png' })).toBe(
      undefined
    );
  });

  test('opens the storage circuit after one failed probe', async () => {
    const loadCover = vi.fn(async () => {
      throw new Error('cover table unavailable');
    });
    const saveCover = vi.fn(async () => {});

    const results = await Promise.allSettled([
      ensureProjectCover({ loadCover, projectId: 'missing-1', saveCover, title: 'First' }),
      ensureProjectCover({ loadCover, projectId: 'missing-2', saveCover, title: 'Second' }),
    ]);

    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(loadCover).toHaveBeenCalledTimes(1);
    expect(requestGeneratedImageMock).not.toHaveBeenCalled();
  });
});
