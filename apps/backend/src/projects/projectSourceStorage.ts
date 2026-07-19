// Server-only Supabase Storage client for immutable project-source objects.
import { createHash } from 'node:crypto';

export const PROJECT_SOURCE_BUCKET = 'project-sources';

export type ProjectSourceStorageErrorCode =
  | 'configuration-invalid'
  | 'delete-failed'
  | 'download-failed'
  | 'integrity-mismatch'
  | 'path-invalid'
  | 'range-invalid'
  | 'upload-failed';

const ERROR_MESSAGES: Record<ProjectSourceStorageErrorCode, string> = {
  'configuration-invalid': 'Supabase project source storage configuration is invalid.',
  'delete-failed': 'Supabase project source deletion failed.',
  'download-failed': 'Supabase project source download failed.',
  'integrity-mismatch': 'Supabase project source integrity verification failed.',
  'path-invalid': 'Supabase project source path is invalid.',
  'range-invalid': 'Supabase project source range response is invalid.',
  'upload-failed': 'Supabase project source upload failed.',
};

export class ProjectSourceStorageError extends Error {
  constructor(
    public readonly code: ProjectSourceStorageErrorCode,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'ProjectSourceStorageError';
  }
}

export interface ProjectSourceIntegrity {
  byteSize: number;
  hash: string;
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
  fetcher?: typeof fetch;
  serviceRoleKey: string;
  supabaseUrl: string;
}

type RequestErrorCode = 'delete-failed' | 'download-failed' | 'range-invalid' | 'upload-failed';

const normalizeConfig = ({
  serviceRoleKey,
  supabaseUrl,
}: SupabaseProjectSourceStorageConfig): {
  serviceRoleKey: string;
  supabaseUrl: string;
} => {
  const normalizedServiceRoleKey = serviceRoleKey.trim();
  const normalizedSupabaseUrl = supabaseUrl.trim().replace(/\/+$/u, '');
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

export class SupabaseProjectSourceStorage {
  private readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly storageUrl: string;

  constructor(config: SupabaseProjectSourceStorageConfig) {
    const { serviceRoleKey, supabaseUrl } = normalizeConfig(config);
    this.fetcher = config.fetcher ?? fetch;
    this.headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };
    this.storageUrl = `${supabaseUrl}/storage/v1`;
  }

  async upload(path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    // Bun fetch accepts ArrayBufferView bodies although its DOM BodyInit type omits them.
    const body = bytes as unknown as BodyInit;
    await this.request(
      'upload-failed',
      `${this.storageUrl}/object/${PROJECT_SOURCE_BUCKET}/${encodeObjectPath(path)}`,
      {
        body,
        headers: {
          ...this.headers,
          'Content-Type': mimeType,
          'x-upsert': 'false',
        },
        method: 'POST',
      }
    );
  }

  async download(path: string, expected: ProjectSourceIntegrity): Promise<Uint8Array> {
    const response = await this.request(
      'download-failed',
      `${this.storageUrl}/object/${PROJECT_SOURCE_BUCKET}/${encodeObjectPath(path)}`,
      {
        headers: this.headers,
        method: 'GET',
      }
    );

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
      `${this.storageUrl}/object/${PROJECT_SOURCE_BUCKET}/${encodeObjectPath(path)}`,
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

  async delete(path: string): Promise<void> {
    encodeObjectPath(path);
    await this.request('delete-failed', `${this.storageUrl}/object/${PROJECT_SOURCE_BUCKET}`, {
      body: JSON.stringify({ prefixes: [path] }),
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      method: 'DELETE',
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
      throw new ProjectSourceStorageError(errorCode, response.status);
    }
    return response;
  }
}
