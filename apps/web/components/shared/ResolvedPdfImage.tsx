import { type ComponentPropsWithoutRef, memo } from 'react';

import { useResolvedProjectDocumentImage } from '../../hooks/useResolvedProjectDocumentImage.ts';
import type { PdfDocumentImageAsset } from '../../types.ts';

interface ResolvedPdfImageProps extends Omit<ComponentPropsWithoutRef<'img'>, 'src'> {
  readonly image: PdfDocumentImageAsset;
  readonly projectId?: string | null;
}

const ResolvedPdfImage = ({ alt, image, projectId, ...imageProps }: ResolvedPdfImageProps) => {
  const resolution = useResolvedProjectDocumentImage(image, projectId);
  return resolution.status === 'ready' && resolution.result ? (
    <img {...imageProps} alt={alt} src={resolution.result.src} />
  ) : null;
};

export default memo(ResolvedPdfImage);
