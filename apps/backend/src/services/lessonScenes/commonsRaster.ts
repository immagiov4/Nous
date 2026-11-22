import { loadImage } from '@napi-rs/canvas';
import {
  COMMONS_USER_AGENT,
  type CommonsImageCandidate,
  commonsRasterUrl,
} from '../commonsImageSearch.js';
import { MAX_GENERATED_IMAGE_BYTES } from '../imageClient.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function rasterMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (bytes.subarray(0, JPEG.length).equals(JPEG)) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return undefined;
}

async function readRasterBytes(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Commons raster body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_GENERATED_IMAGE_BYTES) throw new Error('Commons raster exceeds image limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function fetchCommonsThumbnail(
  thumbnail: string,
  signal: AbortSignal,
  fetcher = fetch
) {
  const url = commonsRasterUrl(thumbnail);
  if (!url) throw new Error('Invalid Commons raster URL');
  const response = await fetcher(url, {
    redirect: 'error',
    signal,
    headers: { 'User-Agent': COMMONS_USER_AGENT },
  });
  if (!response.ok) throw new Error(`Commons raster HTTP ${response.status}`);
  const bytes = await readRasterBytes(response);
  const mediaType = rasterMime(bytes);
  if (!mediaType) throw new Error('Commons response is not a supported raster');
  return { bytes, mediaType };
}

export async function inspectCommonsRaster(
  thumbnail: Awaited<ReturnType<typeof fetchCommonsThumbnail>>,
  signal: AbortSignal
) {
  const { width, height } = await loadImage(thumbnail.bytes);
  signal.throwIfAborted();
  if (!width || !height) throw new Error('Commons raster has no dimensions');
  return { ...thumbnail, width, height };
}

export async function loadCommonsThumbnails(
  candidates: readonly CommonsImageCandidate[],
  signal: AbortSignal
) {
  const thumbnails = await Promise.allSettled(
    candidates.map(async candidate => ({
      candidate,
      raster: await fetchCommonsThumbnail(candidate.thumbnail, signal),
    }))
  );
  return thumbnails.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
}
