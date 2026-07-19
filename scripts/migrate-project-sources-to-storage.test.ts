import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  ProjectSourceStorageError,
  SupabaseProjectSourceStorage,
} from '../apps/backend/src/projects/projectSourceStorage.js';
import {
  classifyProjectSourceSchemaState,
  ensurePrivateProjectSourceBucket,
  migrateProjectSources,
  ProjectSourceDataMigrationError,
  planProjectSourceMigrations,
  prepareHistoricalCodebaseMigration,
  prepareLegacyProjectSourceMigration,
  uploadImmutableProjectSource,
} from './migrate-project-sources-to-storage.js';

const encoder = new TextEncoder();
const USER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'project-1';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const createSnapshotRow = (
  source: unknown,
  projectId = PROJECT_ID,
  learningPlan: unknown = null
) => ({
  project_id: projectId,
  snapshot: {
    activeSectionId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    id: projectId,
    lastOpenedAt: '2026-07-01T00:00:00.000Z',
    learningPlan,
    source,
    sourceKind: 'codebase',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: '1',
  },
  user_id: USER_ID,
});

const createLegacySourceRow = (content = 'legacy PDF bytes') => {
  const data = encoder.encode(content);
  const sourceHash = sha256(data);
  return {
    byte_size: data.byteLength,
    data,
    mime_type: 'application/pdf',
    name: 'manual.pdf',
    project_id: PROJECT_ID,
    source_hash: sourceHash,
    source_id: `source-${sourceHash.slice(0, 24)}`,
    user_id: USER_ID,
  };
};

const createDescriptor = ({
  content,
  id,
  kind = 'pdf',
  name = 'manual.pdf',
  position,
}: {
  content: string;
  id: string;
  kind?: 'markdown' | 'pdf' | 'text';
  name?: string;
  position: number;
}) => ({
  file: {
    data: Buffer.from(content).toString('base64'),
    mimeType: kind === 'pdf' ? 'application/pdf' : 'text/plain',
    name,
    sourceId: id,
  },
  hash: `legacy-${id}`,
  id,
  kind,
  name,
  outline: [],
  outlineOrigin: 'none',
  position,
  status: 'ready',
});

describe('pure migration transforms', () => {
  test('prepares a legacy project_sources row without changing its bytes or identity', () => {
    const row = createLegacySourceRow();

    const candidate = prepareLegacyProjectSourceMigration(row);

    expect(candidate.bytes).toEqual(row.data);
    expect(candidate.stage).toMatchObject({
      byte_size: row.data.byteLength,
      migration_kind: 'project-source-row',
      mime_type: 'application/pdf',
      name: 'manual.pdf',
      object_path: expect.stringMatching(
        new RegExp(
          `^users/${USER_ID}/projects/[a-f0-9]{64}/${row.source_id}/${row.source_hash}/original$`,
          'u'
        )
      ),
      project_id: PROJECT_ID,
      source_hash: row.source_hash,
      source_id: row.source_id,
      staged_snapshot: null,
      source_files: [
        {
          byteSize: row.data.byteLength,
          mimeType: row.mime_type,
          name: row.name,
          objectPath: expect.any(String),
          position: 0,
          sourceHash: row.source_hash,
          sourceId: row.source_id,
        },
      ],
      user_id: USER_ID,
    });
    expect(candidate.objects).toHaveLength(1);
  });

  test('rejects corrupt legacy row metadata without exposing bytes', () => {
    const row = createLegacySourceRow('sensitive byte payload');

    for (const corruptRow of [
      { ...row, byte_size: row.byte_size + 1 },
      { ...row, source_hash: '0'.repeat(64) },
    ]) {
      expect(() => prepareLegacyProjectSourceMigration(corruptRow)).toThrowError(
        expect.objectContaining<ProjectSourceDataMigrationError>({
          code: 'source-integrity-mismatch',
          message: 'Project source migration found inconsistent source metadata.',
          name: 'ProjectSourceDataMigrationError',
          projectId: PROJECT_ID,
        })
      );
    }

    try {
      prepareLegacyProjectSourceMigration({ ...row, source_hash: '0'.repeat(64) });
    } catch (error) {
      expect(String(error)).not.toContain('sensitive byte payload');
    }
  });

  test('preserves the exact historical aggregate as one detached text document', () => {
    const lines = Array.from({ length: 27 }, (_, index) => `line ${index + 1}`);
    const aggregatedText = lines.join('\r\n');
    const snapshotRow = createSnapshotRow({
      aggregatedText,
      files: [],
      kind: 'codebase-bundle',
      name: 'luanti.zip',
      stats: { includedFileCount: 2 },
    });

    const candidate = prepareHistoricalCodebaseMigration(snapshotRow);
    const expectedBytes = encoder.encode(aggregatedText);
    const expectedHash = sha256(expectedBytes);

    expect(candidate.bytes).toEqual(expectedBytes);
    expect(new TextDecoder().decode(candidate.bytes)).toBe(aggregatedText);
    expect(candidate.stage).toMatchObject({
      byte_size: expectedBytes.byteLength,
      migration_kind: 'historical-codebase',
      mime_type: 'text/plain; charset=utf-8',
      name: 'luanti.zip.txt',
      source_hash: expectedHash,
      source_files: [
        {
          byteSize: expectedBytes.byteLength,
          mimeType: 'text/plain; charset=utf-8',
          name: 'luanti.zip.txt',
          objectPath: expect.any(String),
          position: 0,
          sourceHash: expectedHash,
          sourceId: expect.stringMatching(/^source-[a-f0-9]{24}$/u),
        },
      ],
      staged_snapshot: {
        sourceKind: 'document',
        source: {
          file: {
            data: '',
            mimeType: 'text/plain; charset=utf-8',
            name: 'luanti.zip.txt',
          },
          kind: 'document',
          ref: {
            byteSize: expectedBytes.byteLength,
            hash: expectedHash,
            mimeType: 'text/plain; charset=utf-8',
            name: 'luanti.zip.txt',
          },
        },
      },
    });
    expect(candidate.stage.staged_snapshot).not.toHaveProperty('source.aggregatedText');
    expect(candidate.stage.staged_snapshot).not.toHaveProperty('source.files');
  });

  test('refuses historical bundles with file or descriptor payloads instead of discarding them', () => {
    for (const sourceDetails of [
      { files: [{ path: 'src/a.ts', text: 'source A' }], sources: [] },
      {
        files: [],
        sources: [
          createDescriptor({
            content: 'secondary bytes',
            id: 'source-secondary-1',
            position: 0,
          }),
        ],
      },
      { files: { path: 'invalid' }, sources: [] },
    ]) {
      expect(() =>
        prepareHistoricalCodebaseMigration(
          createSnapshotRow({
            aggregatedText: 'historical aggregate',
            kind: 'codebase-bundle',
            name: 'legacy.zip',
            ...sourceDetails,
          })
        )
      ).toThrowError(
        expect.objectContaining<ProjectSourceDataMigrationError>({
          code: 'source-unmigratable',
          projectId: PROJECT_ID,
        })
      );
    }
  });

  test('plans source rows, detached PDFs, embedded-only PDFs, and historical codebases', () => {
    const row = createLegacySourceRow();
    const embeddedBytes = encoder.encode('embedded only');
    const embeddedSource = {
      file: {
        data: Buffer.from(embeddedBytes).toString('base64'),
        mimeType: 'application/pdf',
        name: 'embedded.pdf',
        sourceId: 'source-primary-1',
      },
      kind: 'pdf',
      sources: [
        {
          file: {
            data: Buffer.from(embeddedBytes).toString('base64'),
            mimeType: 'application/pdf',
            name: 'embedded.pdf',
          },
          id: 'source-primary-1',
          position: 0,
        },
      ],
    };
    const rowBackedPdfSnapshot = createSnapshotRow({
      file: {
        data: Buffer.from(row.data).toString('base64'),
        mimeType: row.mime_type,
        name: row.name,
      },
      kind: 'pdf',
    });
    const embeddedSnapshot = createSnapshotRow(embeddedSource, 'project-2');
    const historicalSnapshot = createSnapshotRow(
      {
        aggregatedText: 'historical text',
        files: [],
        kind: 'codebase-bundle',
        name: 'project.zip',
        stats: {},
      },
      'project-3'
    );
    const emptySnapshot = createSnapshotRow(null, 'project-4');

    const candidates = planProjectSourceMigrations(
      [row],
      [historicalSnapshot, emptySnapshot, embeddedSnapshot, rowBackedPdfSnapshot]
    );

    expect(candidates.map(({ stage }) => [stage.project_id, stage.migration_kind])).toEqual([
      [PROJECT_ID, 'project-source-row'],
      ['project-2', 'embedded-source-set'],
      ['project-3', 'historical-codebase'],
    ]);
    expect(candidates[0]?.stage.staged_snapshot).toMatchObject({
      source: {
        file: { data: '' },
        ref: {
          byteSize: row.byte_size,
          hash: row.source_hash,
          id: row.source_id,
        },
      },
    });
    expect(candidates[1]?.bytes).toEqual(embeddedBytes);
    expect(candidates[1]?.stage.staged_snapshot).toMatchObject({
      source: {
        file: { data: '' },
        sources: [{ file: { data: '' }, id: 'source-primary-1' }],
      },
    });
  });

  test('fails the whole plan for ambiguous or unmigratable source state', () => {
    const row = createLegacySourceRow();
    const cases = [
      {
        rows: [row],
        snapshots: [
          createSnapshotRow({
            aggregatedText: 'conflicting source',
            files: [],
            kind: 'codebase-bundle',
            name: 'source.zip',
            stats: {},
          }),
        ],
      },
      {
        rows: [],
        snapshots: [
          createSnapshotRow({
            file: { data: '', mimeType: 'application/pdf', name: 'missing.pdf' },
            kind: 'pdf',
          }),
        ],
      },
      {
        rows: [],
        snapshots: [createSnapshotRow({ kind: 'unknown-source' })],
      },
      {
        rows: [row],
        snapshots: [],
      },
    ];

    for (const input of cases) {
      expect(() => planProjectSourceMigrations(input.rows, input.snapshots)).toThrowError(
        expect.objectContaining<ProjectSourceDataMigrationError>({
          code: 'source-unmigratable',
          message: 'Project source migration found a source that cannot be migrated.',
          name: 'ProjectSourceDataMigrationError',
        })
      );
    }
  });

  test('refuses to discard embedded PDF bytes that disagree with the detached row', () => {
    const row = createLegacySourceRow('row bytes');
    const snapshot = createSnapshotRow({
      file: {
        data: Buffer.from('different embedded bytes').toString('base64'),
        mimeType: row.mime_type,
        name: row.name,
      },
      kind: 'pdf',
    });

    expect(() => planProjectSourceMigrations([row], [snapshot])).toThrowError(
      expect.objectContaining<ProjectSourceDataMigrationError>({
        code: 'source-integrity-mismatch',
        message: 'Project source migration found inconsistent source metadata.',
        name: 'ProjectSourceDataMigrationError',
        projectId: PROJECT_ID,
      })
    );
  });

  test('refuses primary descriptor metadata that disagrees with the legacy source row', () => {
    const row = createLegacySourceRow('same bytes');
    const primary = createDescriptor({
      content: 'same bytes',
      id: 'source-primary-1',
      position: 0,
    });
    const source = {
      file: primary.file,
      kind: 'pdf',
      sources: [primary],
    };
    const snapshot = createSnapshotRow(source);

    for (const sources of [
      [{ ...primary, file: { ...primary.file, name: 'renamed.pdf' } }],
      [{ ...primary, file: { ...primary.file, mimeType: 'text/plain' } }],
    ]) {
      expect(() =>
        planProjectSourceMigrations(
          [row],
          [{ ...snapshot, snapshot: { ...snapshot.snapshot, source: { ...source, sources } } }]
        )
      ).toThrowError(
        expect.objectContaining<ProjectSourceDataMigrationError>({
          code: 'source-integrity-mismatch',
          projectId: PROJECT_ID,
        })
      );
    }
  });

  test('migrates every descriptor, preserves duplicate names and learningPlan, and removes Base64', () => {
    const learningPlan = {
      sections: [{ id: 'section-1', title: 'Do not change me' }],
      title: 'Engine course',
    };
    const documentIndex = {
      chunks: [{ id: 'chunk-1', sequence: 0, text: 'Complete extracted text' }],
      kind: 'pdf-text-index',
    };
    const descriptors = [
      {
        ...createDescriptor({ content: 'primary', id: 'source-primary-1', position: 0 }),
        documentIndex,
      },
      createDescriptor({ content: 'primary', id: 'source-secondary-1', position: 1 }),
      createDescriptor({
        content: 'plain text',
        id: 'source-text-1',
        kind: 'text',
        name: 'manual.pdf',
        position: 2,
      }),
    ];
    const row = createLegacySourceRow('primary');
    const snapshot = createSnapshotRow(
      {
        file: descriptors[0].file,
        kind: 'pdf',
        sources: descriptors,
      },
      PROJECT_ID,
      learningPlan
    );

    const [candidate] = planProjectSourceMigrations([row], [snapshot]);

    expect(candidate.objects).toHaveLength(3);
    expect(candidate.stage.source_files).toEqual([
      expect.objectContaining({
        name: 'manual.pdf',
        position: 0,
        sourceId: 'source-primary-1',
      }),
      expect.objectContaining({
        name: 'manual.pdf',
        position: 1,
        sourceId: 'source-secondary-1',
      }),
      expect.objectContaining({
        name: 'manual.pdf',
        position: 2,
        sourceId: 'source-text-1',
      }),
    ]);
    expect(new Set(candidate.stage.source_files.map(source => source.objectPath)).size).toBe(3);
    expect(candidate.stage.source_files[0]?.sourceHash).toBe(
      candidate.stage.source_files[1]?.sourceHash
    );

    const stagedSnapshot = candidate.stage.staged_snapshot as {
      learningPlan: unknown;
      source: {
        file: { data: string };
        sources: Array<{
          file: { data: string };
          id: string;
          ref: { id: string; objectPath: string };
          documentIndex?: unknown;
        }>;
      };
    };
    expect(stagedSnapshot.learningPlan).toBe(learningPlan);
    expect(stagedSnapshot.learningPlan).toEqual(snapshot.snapshot.learningPlan);
    expect(stagedSnapshot.source.file.data).toBe('');
    expect(stagedSnapshot.source.sources).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ data: '' }),
        id: 'source-primary-1',
        ref: expect.objectContaining({ id: 'source-primary-1', objectPath: expect.any(String) }),
      }),
      expect.objectContaining({
        file: expect.objectContaining({ data: '' }),
        id: 'source-secondary-1',
        ref: expect.objectContaining({ id: 'source-secondary-1', objectPath: expect.any(String) }),
      }),
      expect.objectContaining({
        file: expect.objectContaining({ data: '' }),
        id: 'source-text-1',
        ref: expect.objectContaining({ id: 'source-text-1', objectPath: expect.any(String) }),
      }),
    ]);
    expect(stagedSnapshot.source.sources[0]?.documentIndex).toBe(documentIndex);
    expect(stagedSnapshot.source.sources[1]).not.toHaveProperty('documentIndex');
  });

  test('migrates 42 embedded descriptors without dropping or merging any source', () => {
    const descriptors = Array.from({ length: 42 }, (_, position) =>
      createDescriptor({
        content: `PDF bytes ${position}`,
        id: `source-stable-${String(position + 1).padStart(2, '0')}`,
        name: 'duplicate-name.pdf',
        position,
      })
    );
    const snapshot = createSnapshotRow({
      file: {
        ...descriptors[0].file,
      },
      kind: 'pdf',
      sources: descriptors,
    });

    const [candidate] = planProjectSourceMigrations([], [snapshot]);
    const stagedSnapshot = candidate.stage.staged_snapshot as {
      source: { sources: Array<{ file: { data: string }; ref: { id: string } }> };
    };

    expect(candidate.objects).toHaveLength(42);
    expect(candidate.stage.source_files).toHaveLength(42);
    expect(new Set(candidate.stage.source_files.map(source => source.sourceId)).size).toBe(42);
    expect(stagedSnapshot.source.sources).toHaveLength(42);
    expect(stagedSnapshot.source.sources.every(descriptor => descriptor.file.data === '')).toBe(
      true
    );
    expect(stagedSnapshot.source.sources.map(descriptor => descriptor.ref.id)).toEqual(
      descriptors.map(descriptor => descriptor.id)
    );
  });

  test('keeps a stable descriptor ID while content-addressing each byte revision separately', () => {
    const planRevision = (content: string) => {
      const descriptor = createDescriptor({
        content,
        id: 'source-stable-1',
        position: 0,
      });
      return planProjectSourceMigrations(
        [],
        [
          createSnapshotRow({
            file: descriptor.file,
            kind: 'pdf',
            sources: [descriptor],
          }),
        ]
      )[0];
    };

    const first = planRevision('first revision');
    const second = planRevision('second revision');

    expect(first.stage.source_id).toBe(second.stage.source_id);
    expect(first.stage.source_hash).not.toBe(second.stage.source_hash);
    expect(first.stage.object_path).not.toBe(second.stage.object_path);
    expect(first.stage.object_path).toContain(
      `/${first.stage.source_id}/${first.stage.source_hash}/original`
    );
    expect(second.stage.object_path).toContain(
      `/${second.stage.source_id}/${second.stage.source_hash}/original`
    );
  });
});

describe('Supabase Storage migration boundaries', () => {
  test('creates and verifies the canonical bucket as private', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: '404',
            error: 'Bucket not found',
            message: 'Bucket not found',
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'project-sources', name: 'project-sources', public: false }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      );

    await ensurePrivateProjectSourceBucket({
      fetcher,
      serviceRoleKey: 'service-role-key',
      supabaseUrl: 'https://project.supabase.co/',
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://project.supabase.co/storage/v1/bucket/project-sources',
      {
        headers: {
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
        },
        method: 'GET',
      }
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://project.supabase.co/storage/v1/bucket', {
      body: JSON.stringify({
        id: 'project-sources',
        name: 'project-sources',
        public: false,
      }),
      headers: {
        apikey: 'service-role-key',
        Authorization: 'Bearer service-role-key',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://project.supabase.co/storage/v1/bucket/project-sources',
      {
        headers: {
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
        },
        method: 'GET',
      }
    );
  });

  test('accepts an existing private bucket but rejects a public or unreadable bucket stably', async () => {
    const existingPrivateFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'project-sources', public: false }), {
        status: 200,
      })
    );

    await expect(
      ensurePrivateProjectSourceBucket({
        fetcher: existingPrivateFetcher,
        serviceRoleKey: 'service-role-key',
        supabaseUrl: 'https://project.supabase.co',
      })
    ).resolves.toBeUndefined();

    for (const fetcher of [
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'project-sources', public: true }), { status: 200 })
        ),
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response('sensitive provider details and service-role-key', {
          status: 500,
        })
      ),
    ]) {
      await expect(
        ensurePrivateProjectSourceBucket({
          fetcher,
          serviceRoleKey: 'service-role-key',
          supabaseUrl: 'https://project.supabase.co',
        })
      ).rejects.toMatchObject({
        message: expect.not.stringContaining('sensitive provider details'),
        name: 'ProjectSourceDataMigrationError',
      });
    }
  });

  test('treats an immutable-object 409 as success only after exact download verification', async () => {
    const candidate = prepareLegacyProjectSourceMigration(createLegacySourceRow());
    const storage = {
      download: vi.fn(async () => candidate.bytes),
      upload: vi.fn(async () => {
        throw new ProjectSourceStorageError('upload-failed', 409);
      }),
    };

    await expect(uploadImmutableProjectSource(storage, candidate)).resolves.toEqual({
      uploaded: 0,
      verifiedExisting: 1,
    });
    expect(storage.download).toHaveBeenCalledWith(candidate.stage.object_path, {
      byteSize: candidate.stage.byte_size,
      hash: candidate.stage.source_hash,
    });

    storage.download.mockRejectedValueOnce(new ProjectSourceStorageError('integrity-mismatch'));
    await expect(uploadImmutableProjectSource(storage, candidate)).rejects.toMatchObject({
      code: 'storage-collision',
      message: 'Project source migration found a conflicting storage object.',
      projectId: PROJECT_ID,
    });
  });

  test('handles Supabase Storage duplicate objects exposed as HTTP 400 with statusCode 409', async () => {
    const candidate = prepareLegacyProjectSourceMigration(createLegacySourceRow());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Duplicate',
            message: 'The resource already exists',
            statusCode: '409',
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(new Response(candidate.bytes, { status: 200 }));
    const storage = new SupabaseProjectSourceStorage({
      fetcher,
      serviceRoleKey: 'service-role-key',
      supabaseUrl: 'https://project.supabase.co',
    });

    await expect(uploadImmutableProjectSource(storage, candidate)).resolves.toEqual({
      uploaded: 0,
      verifiedExisting: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('retries a multi-source candidate by verifying every immutable collision exactly', async () => {
    const descriptors = [
      createDescriptor({ content: 'primary', id: 'source-primary-1', position: 0 }),
      createDescriptor({ content: 'secondary', id: 'source-secondary-1', position: 1 }),
    ];
    const [candidate] = planProjectSourceMigrations(
      [],
      [
        createSnapshotRow({
          file: descriptors[0].file,
          kind: 'pdf',
          sources: descriptors,
        }),
      ]
    );
    const bytesByPath = new Map(
      candidate.objects.map(object => [object.objectPath, object.bytes] as const)
    );
    const storage = {
      download: vi.fn(async (path: string) => {
        const bytes = bytesByPath.get(path);
        if (!bytes) {
          throw new Error('unexpected object path');
        }
        return bytes;
      }),
      upload: vi.fn(async () => {
        throw new ProjectSourceStorageError('upload-failed', 400);
      }),
    };

    await expect(uploadImmutableProjectSource(storage, candidate)).resolves.toEqual({
      uploaded: 0,
      verifiedExisting: 2,
    });
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(storage.download).toHaveBeenCalledTimes(2);
    expect(storage.download.mock.calls.map(([path]) => path)).toEqual(
      candidate.objects.map(object => object.objectPath)
    );
  });
});

describe('project source schema classification', () => {
  const freshSchema = {
    has_data: false,
    has_project_snapshots: false,
    has_project_source_deletions: false,
    has_project_source_entries: false,
    has_project_source_files: false,
    has_project_sources: false,
    has_source_kind: false,
  };
  const legacySchema = {
    ...freshSchema,
    has_data: true,
    has_project_snapshots: true,
    has_project_sources: true,
  };
  const cutoverSchema = {
    ...freshSchema,
    has_project_snapshots: true,
    has_project_source_deletions: true,
    has_project_source_entries: true,
    has_project_source_files: true,
    has_project_sources: true,
    has_source_kind: true,
  };

  test('distinguishes genuinely fresh, legacy, and completed schemas', () => {
    expect(classifyProjectSourceSchemaState(freshSchema)).toBe('fresh');
    expect(classifyProjectSourceSchemaState(legacySchema)).toBe('legacy');
    expect(classifyProjectSourceSchemaState(cutoverSchema)).toBe('cutover');
  });

  test('rejects partial or contradictory schemas instead of treating them as fresh', () => {
    for (const partialSchema of [
      { ...freshSchema, has_project_snapshots: true },
      { ...legacySchema, has_project_source_files: true },
      { ...cutoverSchema, has_project_source_entries: false },
      { ...freshSchema, has_data: true },
    ]) {
      expect(() => classifyProjectSourceSchemaState(partialSchema)).toThrowError(
        expect.objectContaining<ProjectSourceDataMigrationError>({
          code: 'database-failed',
        })
      );
    }
  });
});

describe('migrateProjectSources', () => {
  test('validates the complete plan before uploading and stages each verified candidate', async () => {
    const legacyRow = createLegacySourceRow();
    const snapshot = createSnapshotRow({
      file: {
        data: Buffer.from(legacyRow.data).toString('base64'),
        mimeType: legacyRow.mime_type,
        name: legacyRow.name,
      },
      kind: 'pdf',
    });
    const repository = {
      getSchemaState: vi.fn(async () => 'legacy' as const),
      ensureStageTable: vi.fn(async () => undefined),
      listLegacyProjectSources: vi.fn(async () => [legacyRow]),
      listProjectSnapshots: vi.fn(async () => [snapshot]),
      replaceStage: vi.fn(async () => undefined),
    };
    const storage = {
      download: vi.fn(async () => legacyRow.data),
      upload: vi.fn(async () => undefined),
    };
    const ensureBucket = vi.fn(async () => undefined);

    await expect(migrateProjectSources({ ensureBucket, repository, storage })).resolves.toEqual({
      staged: 1,
      uploaded: 1,
      verifiedExisting: 0,
    });
    expect(ensureBucket).toHaveBeenCalledOnce();
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(repository.replaceStage).toHaveBeenCalledWith([
      expect.objectContaining({
        object_path: expect.any(String),
        project_id: PROJECT_ID,
      }),
    ]);

    repository.listLegacyProjectSources.mockResolvedValueOnce([]);
    repository.listProjectSnapshots.mockResolvedValueOnce([
      createSnapshotRow({
        file: { data: '', mimeType: 'application/pdf', name: 'missing.pdf' },
        kind: 'pdf',
      }),
    ]);

    await expect(
      migrateProjectSources({ ensureBucket, repository, storage })
    ).rejects.toMatchObject({
      code: 'source-unmigratable',
    });
    expect(ensureBucket).toHaveBeenCalledOnce();
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(repository.replaceStage).toHaveBeenCalledOnce();
  });

  test('atomically replaces staging with an empty current plan so stale rows cannot survive', async () => {
    const repository = {
      getSchemaState: vi.fn(async () => 'legacy' as const),
      ensureStageTable: vi.fn(async () => undefined),
      listLegacyProjectSources: vi.fn(async () => []),
      listProjectSnapshots: vi.fn(async () => [createSnapshotRow(null)]),
      replaceStage: vi.fn(async () => undefined),
    };
    const storage = {
      download: vi.fn(),
      upload: vi.fn(),
    };

    await expect(
      migrateProjectSources({
        ensureBucket: vi.fn(async () => undefined),
        repository,
        storage,
      })
    ).resolves.toEqual({
      staged: 0,
      uploaded: 0,
      verifiedExisting: 0,
    });
    expect(repository.replaceStage).toHaveBeenCalledExactlyOnceWith([]);
  });

  test('is idempotent after cutover and only verifies the private bucket', async () => {
    const repository = {
      getSchemaState: vi.fn(async () => 'cutover' as const),
      ensureStageTable: vi.fn(),
      listLegacyProjectSources: vi.fn(),
      listProjectSnapshots: vi.fn(),
      replaceStage: vi.fn(),
    };
    const storage = {
      download: vi.fn(),
      upload: vi.fn(),
    };
    const ensureBucket = vi.fn(async () => undefined);

    await expect(migrateProjectSources({ ensureBucket, repository, storage })).resolves.toEqual({
      staged: 0,
      uploaded: 0,
      verifiedExisting: 0,
    });
    expect(ensureBucket).toHaveBeenCalledOnce();
    expect(repository.ensureStageTable).not.toHaveBeenCalled();
    expect(repository.listProjectSnapshots).not.toHaveBeenCalled();
    expect(repository.replaceStage).not.toHaveBeenCalled();

    await expect(
      migrateProjectSources({
        ensureBucket: vi.fn(async () => {
          throw new ProjectSourceDataMigrationError('bucket-not-private');
        }),
        repository,
        storage,
      })
    ).rejects.toMatchObject({
      code: 'bucket-not-private',
      message: 'Project source migration requires a private storage bucket.',
    });
  });

  test('treats only a genuinely fresh schema as a zero-work bootstrap before db push', async () => {
    const repository = {
      getSchemaState: vi.fn(async () => 'fresh' as const),
      ensureStageTable: vi.fn(),
      listLegacyProjectSources: vi.fn(),
      listProjectSnapshots: vi.fn(),
      replaceStage: vi.fn(),
    };
    const ensureBucket = vi.fn(async () => undefined);

    await expect(
      migrateProjectSources({
        ensureBucket,
        repository,
        storage: { download: vi.fn(), upload: vi.fn() },
      })
    ).resolves.toEqual({
      staged: 0,
      uploaded: 0,
      verifiedExisting: 0,
    });
    expect(ensureBucket).toHaveBeenCalledOnce();
    expect(repository.ensureStageTable).not.toHaveBeenCalled();
    expect(repository.listLegacyProjectSources).not.toHaveBeenCalled();
    expect(repository.listProjectSnapshots).not.toHaveBeenCalled();
  });
});
