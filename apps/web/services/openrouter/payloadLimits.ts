const BYTES_PER_MIB = 1024 * 1024;
const OPENROUTER_PROXY_BODY_LIMIT_RATIO = 0.8;

const OPENROUTER_PROXY_JSON_BODY_LIMIT_BYTES = 80 * BYTES_PER_MIB;
export const OPENROUTER_SAFE_JSON_BODY_BYTES = Math.floor(
  OPENROUTER_PROXY_JSON_BODY_LIMIT_BYTES * OPENROUTER_PROXY_BODY_LIMIT_RATIO
);
export const OPENROUTER_INLINE_MEDIA_DATA_URL_LIMIT_CHARS = 8 * BYTES_PER_MIB;

export const OPENROUTER_PAYLOAD_TOO_LARGE_MESSAGE =
  'La richiesta al modello e troppo grande. Riduci allegati o immagini e riprova.';

export const measureUtf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

const getDataUrlLengthForBase64 = (mimeType: string, base64Data: string): number =>
  `data:${mimeType};base64,`.length + base64Data.length;

export const isOpenRouterBase64MediaInlineSafe = (base64Data: string, mimeType: string): boolean =>
  getDataUrlLengthForBase64(mimeType, base64Data) <= OPENROUTER_INLINE_MEDIA_DATA_URL_LIMIT_CHARS;

export const isOpenRouterDataUrlInlineSafe = (dataUrl: string): boolean =>
  dataUrl.length <= OPENROUTER_INLINE_MEDIA_DATA_URL_LIMIT_CHARS;
