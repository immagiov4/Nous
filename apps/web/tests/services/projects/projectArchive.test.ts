import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { test } from 'vitest';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import {
  createProjectArchiveBlob,
  isProjectArchiveFile,
  readProjectImportBundle,
  readProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import { encodeBytesBase64, encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const buildPdfSnapshot = (): ProjectSnapshot => {
  const pdfBytes = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x46, 0x61, 0x6b, 0x65, 0x20, 0x50, 0x44,
    0x46, 0x0a,
  ]);

  return {
    id: 'project-pdf',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: {
      kind: 'pdf',
      file: {
        name: 'dispensa.pdf',
        mimeType: 'application/pdf',
        data: encodeBytesBase64(pdfBytes),
      },
    },
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'lesson-1',
          title: 'Prima lezione',
          moduleTitle: 'Modulo',
        }),
      ],
      {
        title: 'Percorso',
        summary: 'Sintesi',
        backgroundMusicUrl: '',
      }
    ),
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastOpenedAt: '2026-04-03T00:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };
};

test('createProjectArchiveBlob keeps pdf bytes outside the manifest and restores them losslessly on import', async () => {
  const snapshot = buildPdfSnapshot();
  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestText = await zip.file('project.json')?.async('string');

  assert.equal(Boolean(manifestText), true);
  assert.equal(manifestText?.includes('"data"'), false);
  assert.equal(
    manifestText?.includes(snapshot.source?.kind === 'pdf' ? snapshot.source.file.data : ''),
    false
  );
  assert.equal(await isProjectArchiveFile(archive), true);

  const imported = (await readProjectImportData(archive)) as ProjectSnapshot;

  assert.deepEqual(imported.source, snapshot.source);
  assert.equal(flattenLessons(imported.learningPlan?.modules).length, 1);
});

test('source archive backups keep original zip bytes outside the manifest and preserve the index', async () => {
  const snapshot = buildPdfSnapshot();
  const sourceBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x2a, 0x2b, 0x2c, 0x2d]);
  snapshot.source = {
    file: {
      data: encodeBytesBase64(sourceBytes),
      mimeType: 'application/zip',
      name: 'engine-source.zip',
    },
    index: {
      entries: [
        { kind: 'directory', path: 'src' },
        {
          byteSize: 42,
          contentKind: 'text',
          hash: 'a'.repeat(64),
          kind: 'file',
          path: 'src/main.cpp',
          preview: 'int main() {}',
        },
      ],
    },
    kind: 'archive',
    name: 'engine-source.zip',
  };

  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestText = (await zip.file('project.json')?.async('string')) || '';
  const sourceEntry = zip.file('source/engine-source.zip');
  const imported = (await readProjectImportData(archive)) as ProjectSnapshot;
  const binaryImport = await readProjectImportBundle(archive);
  const binarySnapshot = binaryImport.data as ProjectSnapshot;

  assert.ok(sourceEntry);
  assert.equal(manifestText.includes(snapshot.source.file.data), false);
  assert.deepEqual(new Uint8Array(await sourceEntry.async('uint8array')), sourceBytes);
  assert.deepEqual(imported.source, snapshot.source);
  assert.equal(binarySnapshot.source?.file.data, '');
  assert.ok(binaryImport.sourceArchiveFile);
  assert.deepEqual(new Uint8Array(await binaryImport.sourceArchiveFile.arrayBuffer()), sourceBytes);
});

test('multi-source archives preserve every file and derivative without embedding file bytes in the manifest', async () => {
  const snapshot = buildPdfSnapshot();
  const descriptors = buildCourseSourceDescriptors([
    { name: 'b.txt', mimeType: 'text/plain', data: encodeTextBase64('Beta') },
    { name: 'a.md', mimeType: 'text/markdown', data: encodeTextBase64('# Alpha') },
  ]);
  snapshot.source = createProjectSourceFromDescriptors(descriptors);

  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestText = (await zip.file('project.json')?.async('string')) || '';
  const manifest = JSON.parse(manifestText) as {
    project: {
      source?: {
        file?: { data?: string };
        sources?: Array<{ file: { data?: string } }>;
      };
    };
  };
  const imported = (await readProjectImportData(archive)) as ProjectSnapshot;

  assert.equal(zip.file(/^source\//u).length, 2);
  assert.equal(manifest.project.source?.file?.data, '');
  assert.equal(
    manifest.project.source?.sources?.every(source => source.file.data === ''),
    true
  );
  for (const descriptor of descriptors) {
    assert.equal(manifestText.includes(descriptor.file.data), false);
  }
  assert.deepEqual(imported.source, snapshot.source);
});

test('multi-source archive import rejects a missing primary source instead of selecting another file', async () => {
  const snapshot = buildPdfSnapshot();
  const descriptors = buildCourseSourceDescriptors([
    { name: 'b.txt', mimeType: 'text/plain', data: encodeTextBase64('Beta') },
    { name: 'a.md', mimeType: 'text/markdown', data: encodeTextBase64('# Alpha') },
  ]);
  snapshot.source = createProjectSourceFromDescriptors(descriptors);

  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('project.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    project: { source: { file: { sourceId?: string } } };
  };
  manifest.project.source.file.sourceId = 'missing-source';
  zip.file('project.json', JSON.stringify(manifest));
  const invalidArchive = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  await assert.rejects(
    () => readProjectImportData(invalidArchive),
    /Archivio backup non valido: fonte primaria mancante\./
  );
});

test('multi-source archive import rejects an incomplete attachment set instead of losing a source', async () => {
  const snapshot = buildPdfSnapshot();
  const descriptors = buildCourseSourceDescriptors([
    { name: 'b.txt', mimeType: 'text/plain', data: encodeTextBase64('Beta') },
    { name: 'a.md', mimeType: 'text/markdown', data: encodeTextBase64('# Alpha') },
  ]);
  snapshot.source = createProjectSourceFromDescriptors(descriptors);

  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('project.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    attachments: { sourceFiles: unknown[] };
  };
  manifest.attachments.sourceFiles.pop();
  zip.file('project.json', JSON.stringify(manifest));
  const invalidArchive = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  await assert.rejects(
    () => readProjectImportData(invalidArchive),
    /Archivio backup non valido: allegati delle fonti incompleti\./
  );
});

test('isProjectArchiveFile rejects generic source zips and readProjectImportData reports a backup-specific error', async () => {
  const zip = new JSZip();
  zip.file('src/index.ts', 'export const answer = 42;');
  const genericZip = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  assert.equal(await isProjectArchiveFile(genericZip), false);
  await assert.rejects(
    () => readProjectImportData(genericZip),
    /Questo ZIP non contiene un backup Nous valido\./
  );
});

test('readProjectImportData rejects ZIP archives with unsafe paths', async () => {
  const zip = new JSZip();
  zip.file('../secret.txt', 'not allowed');
  const unsafeZip = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  assert.equal(await isProjectArchiveFile(unsafeZip), false);
  await assert.rejects(
    () => readProjectImportData(unsafeZip),
    /Questo ZIP non contiene un backup Nous valido\./
  );
});

test('readProjectImportData still supports legacy json exports', async () => {
  const legacyExport = {
    version: '4.1',
    source: {
      kind: 'pdf',
      file: {
        name: 'dispensa.pdf',
        mimeType: 'application/pdf',
        data: 'ZmFrZQ==',
      },
    },
    learningPlan: null,
    laboratory: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeLaboratoryExerciseId: null,
  };
  const legacyBlob = new Blob([JSON.stringify(legacyExport)], {
    type: 'application/json',
  });

  assert.deepEqual(await readProjectImportData(legacyBlob), legacyExport);
});

test('readProjectImportData rejects arbitrary json files that are not Nous backups', async () => {
  const arbitraryJson = new Blob([JSON.stringify({ ok: true, items: [] })], {
    type: 'application/json',
  });

  await assert.rejects(
    () => readProjectImportData(arbitraryJson),
    /Il file selezionato non e un backup Nous valido\./
  );
});
