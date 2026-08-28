import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProjectBackupArchive,
  decodeProjectBackupArchive,
  LEGACY_PROJECT_BACKUP_ARCHIVE_FORMAT,
  PROJECT_BACKUP_MANIFEST_PATH,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import {
  type DecodedProjectSnapshotWire,
  decodeProjectSnapshotWire,
  PROJECT_SNAPSHOT_FORMAT_VERSION,
  type ProjectSnapshotWire,
} from '@shared/projectSnapshotWire';
import JSZip from 'jszip';
import { expectTypeOf, test } from 'vitest';
import {
  exportProjectData,
  normalizeImportedProject,
} from '../../../services/projects/projectSnapshot.ts';
import { decodeTextBase64 } from '../../../services/projects/projectSource.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';

const limits = {
  invalidArchiveMessage: 'Backup non valido.',
  maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
  maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
};
const legacyProject = JSON.parse(
  readFileSync(resolve('apps/web/tests/fixtures/projects/legacy-codebase-project.json'), 'utf8')
) as Record<string, unknown>;

const readMigratedFiles = (project: ReturnType<typeof decodeProjectSnapshotWire>) => {
  assert.equal(project.source?.kind, 'document');
  assert.ok(Array.isArray(project.source.sources));
  return project.source.sources.map(source => {
    assert.equal(typeof source, 'object');
    assert.ok(source);
    const file = (source as { file?: Record<string, unknown> }).file;
    if (!file) throw new Error('Migrated source file is missing.');
    assert.equal(typeof file?.name, 'string');
    assert.equal(typeof file.data, 'string');
    return { path: file.name as string, text: decodeTextBase64(file.data as string) };
  });
};

test('the authoritative wire decoder migrates a real codebase-bundle fixture without losing files', () => {
  const migrated = decodeProjectSnapshotWire(legacyProject);

  assert.equal(migrated.projectFormatVersion, PROJECT_SNAPSHOT_FORMAT_VERSION);
  assert.equal(migrated.title, 'Corso storico sul parser');
  assert.equal(migrated.sourceKind, 'codebase');
  assert.deepEqual(readMigratedFiles(migrated), [
    { path: 'src/parser.ts', text: "export const parse = () => 'ok';" },
    { path: 'README.md', text: '# Parser storico' },
  ]);
  assert.deepEqual(
    (migrated.source?.sources as Array<{ status?: string }>).map(source => source.status),
    ['partial', 'partial']
  );
  assert.equal(migrated.extensions, undefined);
  assert.deepEqual(migrated.legacyUnmappedFields, { legacyTheme: 'paper' });
  assert.equal(JSON.stringify(migrated).includes('aggregatedText'), false);
  assert.equal(JSON.stringify(migrated).includes('includedFileCount'), false);
});

test('historical archive import and canonical re-export preserve lesson round-trip fields', async () => {
  const legacyZip = new JSZip();
  legacyZip.file(
    PROJECT_BACKUP_MANIFEST_PATH,
    JSON.stringify({
      archiveVersion: 1,
      format: LEGACY_PROJECT_BACKUP_ARCHIVE_FORMAT,
      project: legacyProject,
    })
  );
  const legacyBytes = await legacyZip.generateAsync({ type: 'uint8array' });

  const decodedLegacy = await decodeProjectBackupArchive(legacyBytes, limits);
  expectTypeOf(decodedLegacy.project).toEqualTypeOf<DecodedProjectSnapshotWire>();
  const normalized = normalizeImportedProject(decodedLegacy.project);
  const lesson = flattenLessons(normalized.learningPlan?.modules)[0];
  assert.equal(normalized.title, 'Corso storico sul parser');
  assert.deepEqual(lesson?.instructionPacks, ['code', 'technical-sources']);
  assert.equal(lesson?.lastGenerationRunId, 'run-legacy-17');

  const canonicalExport = exportProjectData(normalized);
  const canonicalBytes = await createProjectBackupArchive({ project: canonicalExport }, limits);
  const decodedCanonical = await decodeProjectBackupArchive(canonicalBytes, limits);
  expectTypeOf(canonicalExport).toEqualTypeOf<ProjectSnapshotWire>();
  const roundTripped = normalizeImportedProject(decodedCanonical.project);
  const roundTrippedLesson = flattenLessons(roundTripped.learningPlan?.modules)[0];

  assert.equal(decodedCanonical.project.projectFormatVersion, PROJECT_SNAPSHOT_FORMAT_VERSION);
  assert.equal(roundTripped.title, normalized.title);
  assert.deepEqual(
    [roundTripped.createdAt, roundTripped.updatedAt, roundTripped.lastOpenedAt],
    [normalized.createdAt, normalized.updatedAt, normalized.lastOpenedAt]
  );
  assert.deepEqual(roundTrippedLesson?.instructionPacks, lesson?.instructionPacks);
  assert.equal(roundTrippedLesson?.lastGenerationRunId, lesson?.lastGenerationRunId);
  assert.deepEqual(roundTripped.legacyUnmappedFields, normalized.legacyUnmappedFields);
  assert.deepEqual(
    readMigratedFiles(decodeProjectSnapshotWire(decodedCanonical.project)),
    readMigratedFiles(decodeProjectSnapshotWire(canonicalExport))
  );
});

test('legacy lesson migration derives Markdown content from structured blocks across round trips', () => {
  const canonicalContent =
    '## Timer\n\n```lua\nlocal tempo = 0\n\nlocal delta = 1\n```\n\nConclusione.';
  const inconsistentLegacyProject = {
    id: 'legacy-divergent-lesson',
    learningPlan: {
      modules: [
        {
          children: [
            {
              content: '## Timer\n\nlocal tempo = 0\n```lua\n\nlocal delta = 1\n```',
              contentBlocks: [{ kind: 'markdown', markdown: canonicalContent }],
              id: 'lesson-1',
              kind: 'lesson',
              title: 'Timer',
            },
          ],
          id: 'module-1',
          title: 'Modulo',
        },
      ],
      title: 'Corso',
    },
    version: '4.1',
  };

  const migrated = normalizeImportedProject(inconsistentLegacyProject);
  const roundTripped = normalizeImportedProject(exportProjectData(migrated));

  assert.equal(flattenLessons(migrated.learningPlan?.modules)[0]?.content, canonicalContent);
  assert.deepEqual(flattenLessons(migrated.learningPlan?.modules)[0]?.contentBlocks, [
    { markdown: canonicalContent, type: 'markdown' },
  ]);
  assert.equal(flattenLessons(roundTripped.learningPlan?.modules)[0]?.content, canonicalContent);
});

test('canonical payloads reject unknown fields and unsupported versions instead of dropping them', () => {
  assert.throws(
    () =>
      decodeProjectSnapshotWire({
        id: 'project-1',
        projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
        title: 'Incomplete project',
      }),
    /snapshot canonico incompleto/iu
  );
  assert.throws(
    () =>
      decodeProjectSnapshotWire({
        projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
        unexpected: true,
      }),
    /campo progetto non supportato.*unexpected/iu
  );
  assert.throws(
    () => decodeProjectSnapshotWire({ projectFormatVersion: 99 }),
    /versione formato progetto non supportata/iu
  );
  assert.throws(
    () =>
      decodeProjectSnapshotWire({
        file: { data: '', mimeType: 'text/plain', name: 'legacy.txt' },
        projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
      }),
    /snapshot canonico con campi sorgente legacy/iu
  );
  assert.throws(
    () =>
      decodeProjectSnapshotWire({
        projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
        source: { files: [], kind: 'codebase-bundle', name: 'legacy' },
      }),
    /snapshot canonico con campi sorgente legacy/iu
  );
});

test('wire decoding rejects empty snapshots and malformed learning-plan collections', () => {
  const invalidSnapshots = [
    {},
    { projectFormatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION },
    { id: 'project-1', learningPlan: {} },
    { id: 'project-1', learningPlan: { modules: [null] } },
    { id: 'project-1', learningPlan: { modules: [{ id: 'module-1' }] } },
    { id: 'project-1', learningPlan: { modules: [{ children: null }] } },
    { id: 'project-1', learningPlan: { modules: [{ children: [null] }] } },
    {
      id: 'project-1',
      learningPlan: {
        modules: [{ children: [{}], id: 'module-1', title: 'Modulo' }],
      },
    },
    {
      id: 'project-1',
      learningPlan: {
        modules: [
          {
            children: [{ id: 'lesson-1', kind: 'lesson' }],
            id: 'module-1',
            title: 'Modulo',
          },
        ],
      },
    },
    { id: 'project-1', learningPlan: { modules: [{ lessons: [null] }] } },
    { source: { kind: 'document' } },
    { source: { file: {}, kind: 'pdf' } },
    {
      source: {
        file: { data: '', mimeType: 'application/zip', name: 'source.zip' },
        index: { entries: [] },
        kind: 'archive',
        name: 'source.zip',
      },
    },
    {
      source: {
        file: { data: 'UEs=', mimeType: 'application/zip', name: 'source.zip' },
        index: { entries: 'bad' },
        kind: 'archive',
        name: 'source.zip',
      },
    },
    {
      source: {
        file: { data: 'dGV4dA==', mimeType: 'text/plain', name: 'source.txt' },
        kind: 'document',
        sources: [{}],
      },
    },
    {
      source: {
        file: { data: 'dGV4dA==', mimeType: 'text/plain', name: 'source.txt' },
        kind: 'document',
        sources: [
          {
            file: { data: 'dGV4dA==', mimeType: 'text/plain', name: 'source.txt' },
            hash: 'hash',
            id: 'source-1',
            kind: 'text',
            name: 'source.txt',
          },
        ],
      },
    },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(
      () => decodeProjectSnapshotWire(snapshot),
      /snapshot|piano didattico|sorgente|descrittore/iu
    );
  }
});

test('source descriptors do not replace required archive bytes', () => {
  assert.throws(
    () =>
      decodeProjectSnapshotWire({
        source: {
          file: {
            data: '',
            mimeType: 'application/zip',
            name: 'source.zip',
            sourceId: 'source-1',
          },
          index: { entries: [] },
          kind: 'archive',
          name: 'source.zip',
          sources: [
            {
              file: {
                data: 'dGV4dA==',
                mimeType: 'text/plain',
                name: 'source.txt',
                sourceId: 'source-1',
              },
              hash: 'hash',
              id: 'source-1',
              kind: 'text',
              name: 'source.txt',
              outline: [],
              outlineOrigin: 'none',
              position: 0,
              status: 'ready',
            },
          ],
        },
      }),
    /sorgente progetto non valida: file/iu
  );
});

test('legacy transient fields are discarded while unknown fields remain quarantined', () => {
  assert.deepEqual(
    decodeProjectSnapshotWire({
      activeLaboratoryExerciseId: 'lab-1',
      id: 'project-1',
      isLearnMode: false,
      laboratory: { status: 'pending' },
      state: 'LIBRARY',
    }),
    {
      id: 'project-1',
      isLearnMode: false,
      state: 'LIBRARY',
    }
  );
  assert.deepEqual(
    decodeProjectSnapshotWire({
      id: 'project-1',
      isLearnMode: false,
      legacyTheme: 'paper',
      state: 'LIBRARY',
    }).legacyUnmappedFields,
    { legacyTheme: 'paper' }
  );
  assert.deepEqual(
    decodeProjectSnapshotWire({
      extensions: { integration: 'example' },
      id: 'project-1',
      isLearnMode: false,
      state: 'LIBRARY',
    }).extensions,
    { integration: 'example' }
  );
});
