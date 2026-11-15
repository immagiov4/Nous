import { type ComponentPropsWithoutRef, memo, useEffect, useState } from 'react';

import { useResolvedProjectDocumentImage } from '../../hooks/useResolvedProjectDocumentImage.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { PdfDocumentImageAsset } from '../../types.ts';
import './ResolvedPdfImage.css';

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
  const [decodedSrc, setDecodedSrc] = useState<string>();
  const [failedSrc, setFailedSrc] = useState<string>();
  const src = resolution.result?.src;
  const failed = resolution.status === 'failed' || (!!src && failedSrc === src);
  // Legacy images without metadata keep the same standard frame through decode or failure.
  const placeholderStyle =
    image.intrinsicWidth && image.intrinsicHeight
      ? {}
      : {
          aspectRatio: '16 / 9',
          width: '100%',
          objectFit: 'contain' as const,
        };
  useEffect(() => {
    if (failed) onUnavailable?.(image.id);
  }, [failed, image.id, onUnavailable]);
  if (resolution.status === 'ready' && src && !failed) {
    return (
      <img
        width={image.intrinsicWidth}
        height={image.intrinsicHeight}
        {...imageProps}
        alt={alt}
        className={`resolved-pdf-image ${className ?? ''}`}
        src={src}
        style={{
          ...placeholderStyle,
          ...imageProps.style,
          opacity: decodedSrc === src ? (imageProps.style?.opacity ?? 1) : 0,
        }}
        onLoad={event => {
          imageProps.onLoad?.(event);
          const node = event.currentTarget;
          // Cached HTTP bytes can still produce a fresh, undecoded blob URL.
          void node.decode().then(
            () => {
              if (node.isConnected && node.getAttribute('src') === src) setDecodedSrc(src);
            },
            () => {
              if (node.isConnected && node.getAttribute('src') === src) setFailedSrc(src);
            }
          );
        }}
        onError={event => {
          imageProps.onError?.(event);
          setFailedSrc(src);
        }}
      />
    );
  }

  if (failed) {
    const label = t('Immagine non disponibile');
    const message = (
      <span className="absolute inset-0 flex items-center justify-center bg-gray-50 px-4 py-6 text-center text-sm text-gray-500 dark:bg-zinc-950 dark:text-zinc-400">
        {label}
      </span>
    );
    return (
      <span className="block text-center leading-none">
        <span
          role="img"
          aria-label={label}
          className={className}
          style={{
            display: 'inline-grid',
            verticalAlign: 'top',
            position: 'relative',
            maxWidth: '100%',
            ...placeholderStyle,
            ...imageProps.style,
          }}
        >
          <img
            alt=""
            aria-hidden="true"
            width={imageProps.width ?? image.intrinsicWidth}
            height={imageProps.height ?? image.intrinsicHeight}
            className={className}
            style={{ ...placeholderStyle, ...imageProps.style, visibility: 'hidden', opacity: 0 }}
          />
          {message}
        </span>
      </span>
    );
  }

  // Keep the measured image box while its asset URL is being resolved.
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      width={imageProps.width ?? image.intrinsicWidth}
      height={imageProps.height ?? image.intrinsicHeight}
      style={{ ...placeholderStyle, ...imageProps.style, visibility: 'hidden', opacity: 0 }}
    />
  );
};

export default memo(ResolvedPdfImage);

import { useAppLocale } from '../../hooks/useAppLocale.ts';
