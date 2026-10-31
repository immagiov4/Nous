// Server-only Supabase Storage client for immutable project-source objects.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { readDiagnosticResponseText } from '../utils/sanitizeDiagnosticText.js';
import { isRecord } from '../utils/validation.js';

export const PROJECT_SOURCE_BUCKET = 'project-sources';
const MAX_SOURCE_OBJECT_BYTES = 200 * 1024 * 1024;

export type ProjectSourceStorageErrorCode =
  | 'object-too-large'
  | 'configuration-invalid'
  | 'delete-failed'
  | 'download-failed'
  | 'integrity-mismatch'
  | 'path-invalid'
  | 'range-invalid'
  | 'upload-failed';

const ERROR_MESSAGES: Record<ProjectSourceStorageErrorCode, string> = {
  'object-too-large': 'The source object exceeds the 200 MiB storage limit.',
  'configuration-invalid': 'Supabase project source storage configuration is invalid.',
  'delete-failed': 'Supabase project source deletion failed.',
  'download-failed': 'Supabase project source download failed.',
  'integrity-mismatch': 'Supabase project source integrity verification failed.',
  'path-invalid': 'Supabase project source path is invalid.',
  'range-invalid': 'Supabase project source range response is invalid.',
  'upload-failed': 'Supabase project source upload failed.',
};

export class ProjectSourceStorageError extends Error {
  readonly storageStatus?: number;
  constructor(
    public readonly code: ProjectSourceStorageErrorCode,
    public readonly status?: number,
    options?: ErrorOptions & { storageStatus?: number }
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'ProjectSourceStorageError';
    this.storageStatus = options?.storageStatus;
  }
}

const readStorageConflictStatus = (message: string | undefined): number | undefined => {
  if (!message) return undefined;
  try {
    const payload: unknown = JSON.parse(message);
    return isRecord(payload) && (payload.statusCode === '409' || payload.statusCode === 409)
      ? 409
      : undefined;
  } catch {
    return undefined;
  }
};

export interface ProjectSourceDiskFile {
  path: string;
  byteSize: number;
  offset?: number;
}

export interface ProjectSourceIntegrity {
  byteSize: number;
  hash: string;
  mimeType?: string;
}

export const verifyProjectSourceBytes = (
  bytes: Uint8Array,
  expected: ProjectSourceIntegrity
): void => {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== expected.byteSize || hash !== expected.hash) {
    throw new ProjectSourceStorageError('integrity-mismatch');
  }
};

export interface SupabaseProjectSourceStorageConfig {
  bucket?: string;
  fetcher?: typeof fetch;
  serviceRoleKey: string;
  supabaseUrl: string;
}

type RequestErrorCode = 'delete-failed' | 'download-failed' | 'range-invalid' | 'upload-failed';

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
};

const normalizeConfig = ({
  serviceRoleKey,
  supabaseUrl,
}: SupabaseProjectSourceStorageConfig): {
  serviceRoleKey: string;
  supabaseUrl: string;
} => {
  const normalizedServiceRoleKey = serviceRoleKey.trim();
  const normalizedSupabaseUrl = trimTrailingSlashes(supabaseUrl.trim());
  let protocol: string | undefined;

  try {
    protocol = new URL(normalizedSupabaseUrl).protocol;
  } catch {
    // The stable domain error below intentionally hides URL parser details.
  }

  if (!normalizedServiceRoleKey || !['http:', 'https:'].includes(protocol || '')) {
    throw new ProjectSourceStorageError('configuration-invalid');
  }

  return {
    serviceRoleKey: normalizedServiceRoleKey,
    supabaseUrl: normalizedSupabaseUrl,
  };
};

const encodeObjectPath = (path: string): string => {
  const segments = path.split('/');
  if (!path || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ProjectSourceStorageError('path-invalid');
  }
  return segments.map(segment => encodeURIComponent(segment)).join('/');
};

const normalizeBucket = (bucket = PROJECT_SOURCE_BUCKET): string => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(bucket)) {
    throw new ProjectSourceStorageError('configuration-invalid');
  }
  return bucket;
};

export class SupabaseProjectSourceStorage {
  private readonly bucket: string;
  private readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly storageUrl: string;

  constructor(config: SupabaseProjectSourceStorageConfig) {
    const { serviceRoleKey, supabaseUrl } = normalizeConfig(config);
    this.bucket = normalizeBucket(config.bucket);
    this.fetcher = config.fetcher ?? fetch;
    this.headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };
    this.storageUrl = `${supabaseUrl}/storage/v1`;
  }

  async upload(
    path: string,
    bytes: Uint8Array | ProjectSourceDiskFile,
    mimeType: string,
    signal?: AbortSignal
  ): Promise<void> {
    const byteSize = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteSize;
    if (byteSize > MAX_SOURCE_OBJECT_BYTES) throw new ProjectSourceStorageError('object-too-large');
    // Bun fetch accepts ArrayBufferView bodies although its DOM BodyInit type omits them.
    const stream = !(bytes instanceof Uint8Array);
    let body = bytes as unknown as BodyInit;
    if (stream) {
      body =
        bytes.byteSize === 0
          ? (new Uint8Array() as unknown as BodyInit)
          : (Readable.toWeb(
              createReadStream(bytes.path, {
                start: bytes.offset ?? 0,
                end: (bytes.offset ?? 0) + bytes.byteSize - 1,
              })
            ) as unknown as BodyInit);
    }
    await this.request(
      'upload-failed',
      `${this.storageUrl}/object/${this.bucket}/${encodeObjectPath(path)}`,
      {
        body,
        headers: {
          ...this.headers,
          'Content-Type': mimeType,
          'x-upsert': 'false',
          ...(stream ? { 'Content-Length': String(bytes.byteSize) } : {}),
        },
        method: 'POST',
        ...(stream ? { duplex: 'half' } : {}),
        ...(signal ? { signal } : {}),
      }
    );
  }

  async download(
    path: string,
    expected: ProjectSourceIntegrity,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const response = await this.request(
      'download-failed',
      `${this.storageUrl}/object/${this.bucket}/${encodeObjectPath(path)}`,
      {
        headers: this.headers,
        method: 'GET',
        ...(signal ? { signal } : {}),
      }
    );

    const actualMimeType = response.headers.get('Content-Type')?.split(';', 1)[0]?.toLowerCase();
    if (expected.mimeType && actualMimeType !== expected.mimeType.toLowerCase()) {
      throw new ProjectSourceStorageError('integrity-mismatch');
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw new ProjectSourceStorageError('download-failed', undefined, { cause });
    }

    verifyProjectSourceBytes(bytes, expected);
    return bytes;
  }

  async downloadRange(
    path: string,
    expectedByteSize: number,
    start: number,
    endExclusive: number
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(expectedByteSize) ||
      expectedByteSize < 0 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(endExclusive) ||
      endExclusive <= start ||
      endExclusive > expectedByteSize
    ) {
      throw new ProjectSourceStorageError('range-invalid');
    }

    const endInclusive = endExclusive - 1;
    const response = await this.request(
      'range-invalid',
      `${this.storageUrl}/object/${this.bucket}/${encodeObjectPath(path)}`,
      {
        headers: {
          ...this.headers,
          Range: `bytes=${start}-${endInclusive}`,
        },
        method: 'GET',
      }
    );
    if (
      response.status !== 206 ||
      response.headers.get('Content-Range') !== `bytes ${start}-${endInclusive}/${expectedByteSize}`
    ) {
      throw new ProjectSourceStorageError('range-invalid', response.status);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw new ProjectSourceStorageError('range-invalid', response.status, { cause });
    }
    if (bytes.byteLength !== endExclusive - start) {
      throw new ProjectSourceStorageError('range-invalid', response.status);
    }
    return bytes;
  }

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    encodeObjectPath(path);
    await this.request('delete-failed', `${this.storageUrl}/object/${this.bucket}`, {
      body: JSON.stringify({ prefixes: [path] }),
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  private async request(
    errorCode: RequestErrorCode,
    url: string,
    init: RequestInit
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (cause) {
      throw new ProjectSourceStorageError(errorCode, undefined, { cause });
    }

    if (!response.ok) {
      const message = await readDiagnosticResponseText(response);
      throw new ProjectSourceStorageError(errorCode, response.status, {
        ...(message ? { cause: new Error(message) } : {}),
        ...(errorCode === 'upload-failed' && response.status === 400
          ? { storageStatus: readStorageConflictStatus(message) }
          : {}),
      });
    }
    return response;
  }
}
