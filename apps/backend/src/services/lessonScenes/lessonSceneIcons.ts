import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { getOpenRouterJsonHeaders, OPENROUTER_API_BASE_URL } from '../openRouterApi.js';

/**
 * Semantic preselection of Tabler icons for lesson scenes (issue #242). Every icon is embedded once
 * from its name, category, and tags; an entry's search phrases retrieve the nearest icons, and a
 * model then chooses among those candidates. The index is cached per embedding model and Tabler
 * version, in memory and on disk, because building it costs one pass over the whole catalog.
 */

interface TablerIconMetadata {
  readonly category?: string;
  readonly name: string;
  readonly styles?: { readonly outline?: unknown };
  readonly tags?: readonly (number | string)[];
}

export interface TablerIcon {
  readonly category: string;
  readonly name: string;
  readonly tags: readonly string[];
}

interface IconIndex {
  readonly icons: readonly TablerIcon[];
  readonly vectors: readonly Float32Array[];
}

const require = createRequire(import.meta.url);
// The package exports only its SVG files, so its metadata is read from the package directory.
const TABLER_PACKAGE_DIRECTORY = path.resolve(
  path.dirname(require.resolve('@tabler/icons/outline/point.svg')),
  '..',
  '..'
);
const readTablerPackageFile = (name: string): Promise<string> =>
  readFile(path.join(TABLER_PACKAGE_DIRECTORY, name), 'utf8');
const EMBEDDING_BATCH_SIZE = 100;
// Approved per-batch limit (issue #242 review): a stalled request must not hold every later scene.
const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;
// Tags shown to the chooser per candidate; enough to reveal what an icon depicts.
const DESCRIBED_TAG_COUNT = 6;
const ICON_INDEX_DIRECTORY =
  process.env.LESSON_SCENE_ICON_INDEX_DIR?.trim() || path.join(os.tmpdir(), 'nous-icon-index');

let tablerIconsPromise: Promise<TablerIcon[]> | undefined;

/** Outline Tabler icons sorted by name, so index rows are stable across runs. */
const loadTablerIcons = (): Promise<TablerIcon[]> => {
  tablerIconsPromise ??= readTablerPackageFile('icons.json').then(text =>
    Object.values(JSON.parse(text) as Record<string, TablerIconMetadata>)
      .filter(icon => icon.styles?.outline)
      .map(icon => ({
        category: icon.category ?? '',
        name: icon.name,
        tags: (icon.tags ?? []).map(String),
      }))
      .sort((first, second) => first.name.localeCompare(second.name))
  );
  return tablerIconsPromise;
};

/** What the chooser reads about a candidate: its name plus category and leading tags. */
export const describeTablerIcon = (icon: TablerIcon): string =>
  `${icon.name} [${icon.category || '-'}: ${icon.tags.slice(0, DESCRIBED_TAG_COUNT).join(', ')}]`;

const indexText = (icon: TablerIcon): string =>
  `${icon.name.replaceAll('-', ' ')}. ${icon.category}. ${icon.tags.join(', ')}`;

const normalize = (values: readonly number[]): Float32Array => {
  const length = Math.hypot(...values);
  return Float32Array.from(values, value => value / length);
};

/** Embeds texts with an OpenRouter embedding model; vectors are unit length. */
export const embedTexts = async (
  model: string,
  texts: readonly string[],
  signal?: AbortSignal
): Promise<Float32Array[]> => {
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/embeddings`, {
      body: JSON.stringify({ input: texts.slice(start, start + EMBEDDING_BATCH_SIZE), model }),
      headers: getOpenRouterJsonHeaders(),
      method: 'POST',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json()) as {
      data?: { embedding: number[]; index: number }[];
    };
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(`Icon embedding request failed with status ${response.status}.`);
    }
    const ordered = [...payload.data].sort((first, second) => first.index - second.index);
    vectors.push(...ordered.map(item => normalize(item.embedding)));
  }
  return vectors;
};

let tablerVersionPromise: Promise<string> | undefined;
const readTablerVersion = (): Promise<string> => {
  tablerVersionPromise ??= readTablerPackageFile('package.json').then(
    text => (JSON.parse(text) as { version: string }).version
  );
  return tablerVersionPromise;
};

const cacheFile = async (model: string): Promise<string> =>
  path.join(
    ICON_INDEX_DIRECTORY,
    `tabler-${await readTablerVersion()}-${encodeURIComponent(model)}.bin`
  );

const CACHE_HEADER_LENGTH_BYTES = 4;

const parseCacheHeader = (bytes: Buffer): { dimensions: number; names: string[] } | null => {
  if (bytes.length < CACHE_HEADER_LENGTH_BYTES) return null;
  const headerLength = bytes.readUInt32LE(0);
  try {
    const header: unknown = JSON.parse(
      bytes
        .subarray(CACHE_HEADER_LENGTH_BYTES, CACHE_HEADER_LENGTH_BYTES + headerLength)
        .toString('utf8')
    );
    const { dimensions, names } = header as { dimensions?: unknown; names?: unknown };
    return Number.isInteger(dimensions) &&
      (dimensions as number) > 0 &&
      Array.isArray(names) &&
      names.every(name => typeof name === 'string')
      ? { dimensions: dimensions as number, names }
      : null;
  } catch {
    return null;
  }
};

// Cache layout: a 4-byte JSON header length, the JSON header {names, dimensions}, then float32 rows.
// A file that does not match this layout or the installed catalog is a cache miss and is rebuilt.
const readCachedIndex = async (
  model: string,
  icons: readonly TablerIcon[]
): Promise<IconIndex | null> => {
  const bytes = await readFile(await cacheFile(model)).catch(() => null);
  const header = bytes && parseCacheHeader(bytes);
  if (
    !bytes ||
    !header ||
    header.names.length !== icons.length ||
    header.names.some((name, index) => name !== icons[index]?.name)
  ) {
    return null;
  }
  const data = bytes.subarray(CACHE_HEADER_LENGTH_BYTES + bytes.readUInt32LE(0));
  if (data.byteLength !== icons.length * header.dimensions * Float32Array.BYTES_PER_ELEMENT) {
    return null;
  }
  const floats = new Float32Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  );
  return {
    icons,
    vectors: icons.map((_, row) =>
      floats.subarray(row * header.dimensions, (row + 1) * header.dimensions)
    ),
  };
};

const writeCachedIndex = async (model: string, index: IconIndex): Promise<void> => {
  const dimensions = index.vectors[0]?.length ?? 0;
  const header = Buffer.from(
    JSON.stringify({ dimensions, names: index.icons.map(icon => icon.name) })
  );
  const headerLength = Buffer.alloc(CACHE_HEADER_LENGTH_BYTES);
  headerLength.writeUInt32LE(header.length, 0);
  const rows = Buffer.concat(
    index.vectors.map(vector => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))
  );
  await mkdir(ICON_INDEX_DIRECTORY, { recursive: true });
  const target = await cacheFile(model);
  // Write then rename, so a concurrent reader never sees a partial file.
  await writeFile(`${target}.tmp`, Buffer.concat([headerLength, header, rows]));
  await rename(`${target}.tmp`, target);
};

const indexPromises = new Map<string, Promise<IconIndex>>();

const buildIndex = async (model: string): Promise<IconIndex> => {
  const icons = await loadTablerIcons();
  const cached = await readCachedIndex(model, icons);
  if (cached) return cached;
  const index = { icons, vectors: await embedTexts(model, icons.map(indexText)) };
  await writeCachedIndex(model, index).catch(error => {
    // The in-memory index still serves this process; only the restart cache is lost.
    console.warn('[lesson-scenes] Icon index cache could not be written.', error);
  });
  return index;
};

export const loadIconIndex = (model: string): Promise<IconIndex> => {
  const existing = indexPromises.get(model);
  if (existing) return existing;
  const promise = buildIndex(model).catch(error => {
    indexPromises.delete(model);
    throw error;
  });
  indexPromises.set(model, promise);
  return promise;
};

const dot = (first: Float32Array, second: Float32Array): number => {
  let sum = 0;
  for (let index = 0; index < first.length; index += 1)
    sum += (first[index] ?? 0) * (second[index] ?? 0);
  return sum;
};

/** The `count` icons whose embeddings are nearest to the query vector, best first. */
export const nearestIcons = (index: IconIndex, query: Float32Array, count: number): TablerIcon[] =>
  index.vectors
    .map((vector, row) => ({ row, score: dot(vector, query) }))
    .sort((first, second) => second.score - first.score)
    .slice(0, count)
    .flatMap(({ row }) => (index.icons[row] ? [index.icons[row]] : []));
