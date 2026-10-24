import { type ComponentPropsWithoutRef, memo, useEffect } from 'react';

import { useResolvedProjectDocumentImage } from '../../hooks/useResolvedProjectDocumentImage.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { PdfDocumentImageAsset } from '../../types.ts';

interface ResolvedPdfImageProps extends Omit<ComponentPropsWithoutRef<'img'>, 'src'> {
  readonly image: PdfDocumentImageAsset;
  readonly projectId?: string | null;
  readonly onUnavailable?: (imageId: string) => void;
}

const ResolvedPdfImage = ({
  alt,
  className,
  image,
  projectId,
  onUnavailable,
  ...imageProps
}: ResolvedPdfImageProps) => {
  useAppLocale();
  const resolution = useResolvedProjectDocumentImage(image, projectId);
  useEffect(() => {
    if (resolution.status === 'failed') onUnavailable?.(image.id);
  }, [resolution.status, image.id, onUnavailable]);
  if (resolution.status === 'ready' && resolution.result) {
    return (
      <img
        {...imageProps}
        alt={alt}
        className={className}
        src={resolution.result.src}
        onError={event => {
          imageProps.onError?.(event);
          onUnavailable?.(image.id);
        }}
      />
    );
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

import { useAppLocale } from '../../hooks/useAppLocale.ts';
