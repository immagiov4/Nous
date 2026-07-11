export type GeneratedRasterMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

interface ParsedGeneratedImageDataUrl {
  mediaType: GeneratedRasterMediaType;
}

const GENERATED_IMAGE_DATA_URL_PATTERN =
  /^data:(image\/(?:jpeg|png|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

export const parseGeneratedImageDataUrl = (value: unknown): ParsedGeneratedImageDataUrl | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = GENERATED_IMAGE_DATA_URL_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    mediaType: match[1] as GeneratedRasterMediaType,
  };
};

export const isSafeGeneratedImageDataUrl = (value: unknown): value is string =>
  parseGeneratedImageDataUrl(value) !== null;

const GENERATED_SVG_IMAGE_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

export const isSafeGeneratedImageSource = (value: unknown): value is string =>
  isSafeGeneratedImageDataUrl(value) ||
  (typeof value === 'string' && value.startsWith(GENERATED_SVG_IMAGE_DATA_URL_PREFIX));
