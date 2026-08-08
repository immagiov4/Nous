import type { ProjectDocumentImageAsset } from '@shared/projectAsset';

import type { PdfDocumentImageAsset } from '../../types.ts';
import { downloadProjectAssetBytes } from './projectAssetClient.ts';

export interface ResolvedProjectDocumentImage {
  readonly release: () => void;
  readonly src: string;
}

const isDurableDocumentImage = (image: PdfDocumentImageAsset): image is ProjectDocumentImageAsset =>
  'asset' in image;

export const asLegacyProjectDocumentImage = (
  image: PdfDocumentImageAsset
): ResolvedProjectDocumentImage | null =>
  isDurableDocumentImage(image) ? null : { release: () => {}, src: image.dataUrl };

export const resolveProjectDocumentImage = async ({
  image,
  projectId,
  signal,
}: {
  readonly image: PdfDocumentImageAsset;
  readonly projectId?: string | null;
  readonly signal: AbortSignal;
}): Promise<ResolvedProjectDocumentImage> => {
  if (isDurableDocumentImage(image)) {
    const bytes = await downloadProjectAssetBytes(projectId || '', image.asset, signal);
    signal.throwIfAborted();
    const src = URL.createObjectURL(
      new Blob([Uint8Array.from(bytes).buffer], { type: image.asset.mediaType })
    );
    return { release: () => URL.revokeObjectURL(src), src };
  }
  return { release: () => {}, src: image.dataUrl };
};
