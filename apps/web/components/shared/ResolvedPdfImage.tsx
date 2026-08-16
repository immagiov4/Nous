import { type ComponentPropsWithoutRef, memo } from 'react';

import { useResolvedProjectDocumentImage } from '../../hooks/useResolvedProjectDocumentImage.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { PdfDocumentImageAsset } from '../../types.ts';

interface ResolvedPdfImageProps extends Omit<ComponentPropsWithoutRef<'img'>, 'src'> {
  readonly image: PdfDocumentImageAsset;
  readonly projectId?: string | null;
}

const ResolvedPdfImage = ({
  alt,
  className,
  image,
  projectId,
  ...imageProps
}: ResolvedPdfImageProps) => {
  const resolution = useResolvedProjectDocumentImage(image, projectId);
  if (resolution.status === 'ready' && resolution.result) {
    return <img {...imageProps} alt={alt} className={className} src={resolution.result.src} />;
  }

  if (resolution.status === 'failed') {
    return (
      <span
        aria-label={t('Immagine non disponibile')}
        className={`flex items-center justify-center bg-gray-50 px-4 py-6 text-center text-sm text-gray-500 dark:bg-zinc-950 dark:text-zinc-400 ${className ?? ''}`}
        role="img"
      >
        {t('Immagine non disponibile')}
      </span>
    );
  }

  return null;
};

export default memo(ResolvedPdfImage);
