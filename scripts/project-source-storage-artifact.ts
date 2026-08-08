import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import postgres from 'postgres';

const ARTIFACT_FORMAT = 'nous-project-sources-v1';
const PROJECT_SOURCE_BUCKET = 'project-sources';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MANIFEST_NAME = 'manifest.json';
const OBJECTS_DIRECTORY_NAME = 'objects';

interface RawProjectSourceReference {
  byte_size: bigint | number | string;
  object_path: string;
  source_hash: string;
}

interface ProjectSourceReference {
  byteSize: number;
  hash: string;
  objectPath: string;
}

interface ProjectSourceStorageManifest {
  bucket: typeof PROJECT_SOURCE_BUCKET;
  databaseDumpSha256: string;
  format: typeof ARTIFACT_FORMAT;
  objects: ProjectSourceReference[];
}

interface StorageOperation {
  databaseDumpSha256: string;
  directory: string;
}

interface StorageTransfer extends StorageOperation {
  fetcher?: typeof fetch;
  references: RawProjectSourceReference[];
  serviceRoleKey: string;
  supabaseUrl: string;
}

export class ProjectSourceStorageArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectSourceStorageArtifactError';
  }
}

const fail = (message: string, options?: ErrorOptions): never => {
  throw new ProjectSourceStorageArtifactError(message, options);
};

const validateSha256 = (value: string, label: string): string => {
  if (!SHA256_PATTERN.test(value)) fail(`Invalid ${label}.`);
  return value;
};

const normalizeByteSize = (value: bigint | number | string): number => {
  const byteSize = Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    fail('Invalid project source byte size.');
  }
  return byteSize;
};

const encodeObjectPath = (objectPath: string): string => {
  const segments = objectPath.split('/');
  if (!objectPath || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('Invalid project source object path.');
  }
  return segments.map(segment => encodeURIComponent(segment)).join('/');
};

const normalizeReferences = (
  rows: readonly RawProjectSourceReference[]
): ProjectSourceReference[] => {
  const references = new Map<string, ProjectSourceReference>();
  for (const row of rows) {
    const reference = {
      byteSize: normalizeByteSize(row.byte_size),
      hash: validateSha256(row.source_hash, 'project source hash'),
      objectPath: row.object_path,
    };
    encodeObjectPath(reference.objectPath);
    const existing = references.get(reference.objectPath);
    if (
      existing &&
      (existing.byteSize !== reference.byteSize || existing.hash !== reference.hash)
    ) {
      fail('Conflicting integrity metadata for a project source object path.');
    }
    references.set(reference.objectPath, reference);
  }
  return [...references.values()].sort((left, right) => {
    if (left.objectPath < right.objectPath) return -1;
    if (left.objectPath > right.objectPath) return 1;
    return 0;
  });
};

const objectFileName = (objectPath: string): string =>
  createHash('sha256').update(objectPath).digest('hex');

const objectFilePath = (directory: string, objectPath: string): string =>
  path.join(directory, OBJECTS_DIRECTORY_NAME, objectFileName(objectPath));

const storageConfiguration = (
  supabaseUrl: string,
  serviceRoleKey: string
): { headers: Record<string, string>; storageUrl: string } => {
  const normalizedUrl = supabaseUrl.trim().replace(/\/+$/u, '');
  const normalizedKey = serviceRoleKey.trim();
  let protocol = '';
  try {
    protocol = new URL(normalizedUrl).protocol;
  } catch {
    // The stable error below intentionally hides URL parser details.
  }
  if (!normalizedKey || !['http:', 'https:'].includes(protocol)) {
    fail('Invalid Supabase Storage configuration.');
  }
  return {
    headers: {
      apikey: normalizedKey,
      Authorization: `Bearer ${normalizedKey}`,
    },
    storageUrl: `${normalizedUrl}/storage/v1/object/${PROJECT_SOURCE_BUCKET}`,
  };
};

const storageObjectUrl = (storageUrl: string, objectPath: string): string =>
  `${storageUrl}/${encodeObjectPath(objectPath)}`;

const request = async (
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string
): Promise<Response> => {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    return fail(`Supabase Storage ${operation} failed.`, { cause });
  }
};

const digestResponse = async (response: Response): Promise<{ byteSize: number; hash: string }> => {
  const body = response.body || fail('Supabase Storage returned an unreadable object.');
  const reader = body.getReader();
  const hash = createHash('sha256');
  let byteSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteSize += value.byteLength;
    hash.update(value);
  }
  return { byteSize, hash: hash.digest('hex') };
};

const verifyDigest = (
  actual: { byteSize: number; hash: string },
  expected: ProjectSourceReference
): void => {
  if (actual.byteSize !== expected.byteSize || actual.hash !== expected.hash) {
    fail(`Project source object integrity mismatch: ${expected.objectPath}.`);
  }
};

const downloadObject = async (
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  destination: string,
  expected: ProjectSourceReference
): Promise<void> => {
  const response = await request(fetcher, url, { headers, method: 'GET' }, 'download');
  if (!response.ok || !response.body) {
    fail(`Supabase Storage download failed for ${expected.objectPath}.`);
  }

  const temporaryPath = `${destination}.partial-${randomUUID()}`;
  const file = await open(temporaryPath, 'wx');
  const body =
    response.body || fail(`Supabase Storage download failed for ${expected.objectPath}.`);
  const reader = body.getReader();
  const hash = createHash('sha256');
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      byteSize += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await file.write(value, offset, value.byteLength - offset);
        offset += result.bytesWritten;
      }
    }
  } finally {
    await file.close();
  }

  try {
    verifyDigest({ byteSize, hash: hash.digest('hex') }, expected);
    await rename(temporaryPath, destination);
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
};

const digestFile = async (filePath: string): Promise<{ byteSize: number; hash: string }> => {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { byteSize, hash: hash.digest('hex') };
};

const compareKeysByCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort(compareKeysByCodeUnit);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const parseManifest = (value: unknown): ProjectSourceStorageManifest => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      'bucket',
      'databaseDumpSha256',
      'format',
      'objects',
    ])
  ) {
    return fail('Invalid project source backup manifest structure.');
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.bucket !== PROJECT_SOURCE_BUCKET ||
    manifest.format !== ARTIFACT_FORMAT ||
    typeof manifest.databaseDumpSha256 !== 'string' ||
    !SHA256_PATTERN.test(manifest.databaseDumpSha256) ||
    !Array.isArray(manifest.objects)
  ) {
    return fail('Invalid project source backup manifest structure.');
  }

  const objects = manifest.objects.map(object => {
    if (
      !object ||
      typeof object !== 'object' ||
      Array.isArray(object) ||
      !exactKeys(object as Record<string, unknown>, ['byteSize', 'hash', 'objectPath'])
    ) {
      return fail('Invalid project source backup manifest structure.');
    }
    const entry = object as Record<string, unknown>;
    if (
      typeof entry.byteSize !== 'number' ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0 ||
      typeof entry.hash !== 'string' ||
      !SHA256_PATTERN.test(entry.hash) ||
      typeof entry.objectPath !== 'string'
    ) {
      return fail('Invalid project source backup manifest structure.');
    }
    encodeObjectPath(entry.objectPath);
    return {
      byteSize: entry.byteSize,
      hash: entry.hash,
      objectPath: entry.objectPath,
    };
  });

  const normalizedObjects = normalizeReferences(
    objects.map(object => ({
      byte_size: object.byteSize,
      object_path: object.objectPath,
      source_hash: object.hash,
    }))
  );
  if (
    normalizedObjects.length !== objects.length ||
    normalizedObjects.some((object, index) => object.objectPath !== objects[index]?.objectPath)
  ) {
    return fail('Invalid project source backup manifest structure.');
  }
  return {
    bucket: PROJECT_SOURCE_BUCKET,
    databaseDumpSha256: manifest.databaseDumpSha256,
    format: ARTIFACT_FORMAT,
    objects: normalizedObjects,
  };
};

const sameReferences = (
  left: readonly ProjectSourceReference[],
  right: readonly ProjectSourceReference[]
): boolean =>
  left.length === right.length &&
  left.every(
    (reference, index) =>
      reference.objectPath === right[index]?.objectPath &&
      reference.hash === right[index]?.hash &&
      reference.byteSize === right[index]?.byteSize
  );

export const createProjectSourceStorageBackup = async ({
  databaseDumpSha256,
  directory,
  fetcher = fetch,
  references: rawReferences,
  serviceRoleKey,
  supabaseUrl,
}: StorageTransfer): Promise<void> => {
  validateSha256(databaseDumpSha256, 'database dump SHA-256');
  const references = normalizeReferences(rawReferences);
  const { headers, storageUrl } = storageConfiguration(supabaseUrl, serviceRoleKey);

  await mkdir(directory);
  try {
    const objectsDirectory = path.join(directory, OBJECTS_DIRECTORY_NAME);
    await mkdir(objectsDirectory);
    for (const reference of references) {
      await downloadObject(
        fetcher,
        storageObjectUrl(storageUrl, reference.objectPath),
        headers,
        objectFilePath(directory, reference.objectPath),
        reference
      );
    }
    const manifest: ProjectSourceStorageManifest = {
      bucket: PROJECT_SOURCE_BUCKET,
      databaseDumpSha256,
      format: ARTIFACT_FORMAT,
      objects: references,
    };
    await writeFile(path.join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    await verifyProjectSourceStorageBackup({ databaseDumpSha256, directory });
  } catch (cause) {
    await rm(directory, { force: true, recursive: true });
    throw cause;
  }
};

export const verifyProjectSourceStorageBackup = async ({
  databaseDumpSha256,
  directory,
}: StorageOperation): Promise<ProjectSourceReference[]> => {
  validateSha256(databaseDumpSha256, 'database dump SHA-256');
  const rootEntries = await readdir(directory, { withFileTypes: true }).catch(cause =>
    fail('Invalid project source backup structure.', { cause })
  );
  if (
    rootEntries.length !== 2 ||
    !rootEntries.some(entry => entry.isFile() && entry.name === MANIFEST_NAME) ||
    !rootEntries.some(entry => entry.isDirectory() && entry.name === OBJECTS_DIRECTORY_NAME)
  ) {
    fail('Invalid project source backup structure.');
  }

  let manifest: ProjectSourceStorageManifest;
  try {
    manifest = parseManifest(
      JSON.parse(await readFile(path.join(directory, MANIFEST_NAME), 'utf8'))
    );
  } catch (cause) {
    if (cause instanceof ProjectSourceStorageArtifactError) throw cause;
    return fail('Invalid project source backup manifest structure.', { cause });
  }
  if (manifest.databaseDumpSha256 !== databaseDumpSha256) {
    fail('Project source backup does not match the database dump.');
  }

  const objectEntries = await readdir(path.join(directory, OBJECTS_DIRECTORY_NAME), {
    withFileTypes: true,
  });
  const expectedNames = new Set(manifest.objects.map(object => objectFileName(object.objectPath)));
  if (
    expectedNames.size !== manifest.objects.length ||
    objectEntries.length !== expectedNames.size ||
    objectEntries.some(entry => !entry.isFile() || !expectedNames.has(entry.name))
  ) {
    fail('Invalid project source backup structure.');
  }

  for (const object of manifest.objects) {
    const filePath = objectFilePath(directory, object.objectPath);
    const stats = await lstat(filePath).catch(cause =>
      fail('Invalid project source backup structure.', { cause })
    );
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail('Invalid project source backup structure.');
    }
    verifyDigest(await digestFile(filePath), object);
  }
  return manifest.objects;
};

const verifyRemoteObject = async (
  response: Response,
  expected: ProjectSourceReference
): Promise<void> => {
  if (!response.ok) fail(`Supabase Storage read failed for ${expected.objectPath}.`);
  verifyDigest(await digestResponse(response), expected);
};

const restoreObject = async (
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  filePath: string,
  expected: ProjectSourceReference
): Promise<void> => {
  const existing = await request(fetcher, url, { headers, method: 'GET' }, 'read');
  if (existing.ok) {
    await verifyRemoteObject(existing, expected);
    return;
  }
  if (existing.status !== 404) {
    fail(`Supabase Storage read failed for ${expected.objectPath}.`);
  }

  const uploaded = await request(
    fetcher,
    url,
    {
      body: await openAsBlob(filePath),
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'false',
      },
      method: 'POST',
    },
    'upload'
  );
  if (!uploaded.ok && ![400, 409].includes(uploaded.status)) {
    fail(`Supabase Storage upload failed for ${expected.objectPath}.`);
  }

  const restored = await request(fetcher, url, { headers, method: 'GET' }, 'read');
  await verifyRemoteObject(restored, expected);
};

export const restoreProjectSourceStorageBackup = async ({
  databaseDumpSha256,
  directory,
  fetcher = fetch,
  references: rawReferences,
  serviceRoleKey,
  supabaseUrl,
}: StorageTransfer): Promise<void> => {
  const manifestReferences = await verifyProjectSourceStorageBackup({
    databaseDumpSha256,
    directory,
  });
  const databaseReferences = normalizeReferences(rawReferences);
  if (!sameReferences(manifestReferences, databaseReferences)) {
    fail('Project source backup does not match the restored database reference set.');
  }

  const { headers, storageUrl } = storageConfiguration(supabaseUrl, serviceRoleKey);
  for (const reference of manifestReferences) {
    await restoreObject(
      fetcher,
      storageObjectUrl(storageUrl, reference.objectPath),
      headers,
      objectFilePath(directory, reference.objectPath),
      reference
    );
  }
};

export const queryProjectSourceReferences = async (
  sql: postgres.Sql
): Promise<RawProjectSourceReference[]> =>
  sql<RawProjectSourceReference[]>`
    select object_path, source_hash, byte_size
    from public.project_sources
    union all
    select object_path, source_hash, byte_size
    from public.project_source_files
    union all
    select object_path, source_hash, byte_size
    from public.project_source_entries
    where kind = 'file'
    order by object_path
  `;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  return value || fail(`${name} is required.`);
};

const main = async (): Promise<void> => {
  const [command, directory, databaseDumpSha256] = process.argv.slice(2);
  if (!command || !directory || !databaseDumpSha256) {
    fail(
      'Usage: bun scripts/project-source-storage-artifact.ts backup|verify|restore <directory> <database-dump-sha256>'
    );
  }
  if (command === 'verify') {
    const objects = await verifyProjectSourceStorageBackup({ databaseDumpSha256, directory });
    console.log(`Verified ${objects.length} project source objects.`);
    return;
  }
  if (!['backup', 'restore'].includes(command)) fail(`Unknown command: ${command}.`);

  const sql = postgres(requiredEnvironment('DATABASE_URL'), { max: 1 });
  try {
    const operation = {
      databaseDumpSha256,
      directory,
      references: await queryProjectSourceReferences(sql),
      serviceRoleKey: requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      supabaseUrl: requiredEnvironment('SUPABASE_URL'),
    };
    if (command === 'backup') {
      await createProjectSourceStorageBackup(operation);
      console.log(`Backed up ${operation.references.length} project source references.`);
    } else {
      await restoreProjectSourceStorageBackup(operation);
      console.log(`Restored ${operation.references.length} project source references.`);
    }
  } finally {
    await sql.end();
  }
};

if (import.meta.main) {
  main().catch(error => {
    console.error(
      error instanceof Error ? error.message : 'Project source Storage operation failed.'
    );
    process.exitCode = 1;
  });
}
