import type { ProjectDocumentImageAsset } from '@shared/projectAsset';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { downloadProjectAssetBytes } from '../../../services/projects/projectAssetClient.ts';
import { resolveProjectDocumentImage } from '../../../services/projects/projectDocumentImageResolver.ts';
import type { PdfImageAsset } from '../../../types.ts';

vi.mock('../../../services/projects/projectAssetClient.ts', () => ({
  downloadProjectAssetBytes: vi.fn(),
}));

const durableImage: ProjectDocumentImageAsset = {
  asset: {
    byteSize: 4,
    hash: 'b'.repeat(64),
    id: 'a'.repeat(64),
    mediaType: 'image/png',
  },
  id: 'pdf-image-logical-1',
  sourceOrder: 1,
  textAfter: 'dopo',
  textBefore: 'prima',
};

const legacyImage: PdfImageAsset = {
  dataUrl: 'data:image/png;base64,TEVHQUNZ',
  id: durableImage.id,
  mimeType: 'image/png',
  sourceOrder: 1,
  textAfter: 'dopo',
  textBefore: 'prima',
};

describe('projectDocumentImageResolver', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    createObjectURL.mockReturnValue('blob:verified-pdf-image');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  test('keeps the legacy data URL adapter allocation-free', async () => {
    const result = await resolveProjectDocumentImage({
      image: legacyImage,
      projectId: null,
      signal: new AbortController().signal,
    });

    expect(result.src).toBe(legacyImage.dataUrl);
    expect(downloadProjectAssetBytes).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    result.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test('downloads a durable asset and releases its transient URL', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.mocked(downloadProjectAssetBytes).mockResolvedValue(bytes);
    const signal = new AbortController().signal;

    const result = await resolveProjectDocumentImage({
      image: durableImage,
      projectId: 'project-1',
      signal,
    });

    expect(downloadProjectAssetBytes).toHaveBeenCalledWith('project-1', durableImage.asset, signal);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(result.src).toBe('blob:verified-pdf-image');

    result.release();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-pdf-image');
  });

  test('does not allocate a URL when the request is aborted during download', async () => {
    const controller = new AbortController();
    vi.mocked(downloadProjectAssetBytes).mockImplementation(async () => {
      controller.abort();
      return new Uint8Array([1, 2, 3, 4]);
    });

    await expect(
      resolveProjectDocumentImage({
        image: durableImage,
        projectId: 'project-1',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
