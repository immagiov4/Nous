import assert from 'node:assert/strict';
import type { ProjectAssetRef, ProjectLessonVisual } from '@shared/projectAsset';
import {
  decodeProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
  PROJECT_COVER_MAX_BYTES,
} from '@shared/projectBackupArchive';
import JSZip from 'jszip';
import { test } from 'vitest';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import {
  createProjectArchiveBlob,
  inspectProjectArchiveData,
  isProjectArchiveFile,
  readLegacyProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import {
  exportProjectData,
  normalizeImportedProject,
} from '../../../services/projects/projectSnapshot.ts';
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

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const decodeArchive = async (archive: Blob) =>
  decodeProjectBackupArchive<ProjectSnapshot>(new Uint8Array(await archive.arrayBuffer()), {
    invalidArchiveMessage: 'Questo ZIP non contiene un backup Nous valido.',
    maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
    maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
    maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
  });

const buildAssetSnapshot = async (): Promise<{
  assets: Map<string, Uint8Array>;
  snapshot: ProjectSnapshot;
}> => {
  const snapshot = buildPdfSnapshot();
  const imageBytes = new Uint8Array([1, 2, 3]);
  const embeddedBytes = new Uint8Array([4, 5, 6, 7]);
  const imageRef: ProjectAssetRef = {
    byteSize: imageBytes.byteLength,
    hash: await sha256(imageBytes),
    id: 'b'.repeat(64),
    mediaType: 'image/png',
  };
  const embeddedRef: ProjectAssetRef = {
    byteSize: embeddedBytes.byteLength,
    hash: await sha256(embeddedBytes),
    id: 'a'.repeat(64),
    mediaType: 'image/webp',
  };
  const lesson = flattenLessons(snapshot.learningPlan?.modules)[0];
  assert.ok(lesson);
  lesson.generatedVisuals = [
    {
      createdAt: snapshot.createdAt,
      id: 'image-visual',
      render: { asset: imageRef, kind: 'image' },
      slotId: 'image-slot',
    },
    {
      createdAt: snapshot.createdAt,
      id: 'html-visual',
      render: {
        code: `<img src="{{PROJECT_ASSET:${embeddedRef.id}}}"><img src="{{PROJECT_ASSET:${embeddedRef.id}}}">`,
        embeddedAssets: [embeddedRef],
        kind: 'html',
      },
      slotId: 'html-slot',
    },
  ] satisfies ProjectLessonVisual[];
  snapshot.documentAssets = {
    imageCount: 1,
    kind: 'pdf',
    parsedAt: snapshot.createdAt,
    usedImages: [
      {
        dataUrl: 'data:image/jpeg;base64,cGRmLWltYWdl',
        id: 'pdf-image-1',
        mimeType: 'image/jpeg',
        sourceOrder: 1,
        textAfter: '',
        textBefore: '',
      },
    ],
  };
  return {
    assets: new Map([
      [imageRef.id, imageBytes],
      [embeddedRef.id, embeddedBytes],
    ]),
    snapshot,
  };
};

test('project archive v2 stores durable, PDF, and cover bytes outside a stable manifest', async () => {
  const { assets, snapshot } = await buildAssetSnapshot();
  const cover = { data: 'Y292ZXI=', mimeType: 'image/webp', name: 'cover.webp' };
  const archive = await createProjectArchiveBlob(snapshot, {
    cover,
    loadAsset: async ref => assets.get(ref.id) || new Uint8Array(),
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestText = await zip.file('project.json')?.async('string');
  assert.ok(manifestText);
  const manifest = JSON.parse(manifestText) as {
    archiveVersion: number;
    attachments: {
      assets: Array<{ id: string; path: string }>;
      cover: { path: string };
      documentImages: Array<{ id: string; path: string }>;
    };
    project: { documentAssets: { usedImages: Array<{ dataUrl: string }> } };
  };

  assert.equal(manifest.archiveVersion, 2);
  assert.deepEqual(
    manifest.attachments.assets.map(asset => asset.id),
    [...assets.keys()].sort()
  );
  assert.equal(manifest.project.documentAssets.usedImages[0]?.dataUrl, '');
  assert.ok(zip.file(manifest.attachments.cover.path));
  assert.ok(zip.file(manifest.attachments.documentImages[0]?.path || ''));

  const decoded = await decodeArchive(archive);
  const imported = decoded.project;
  assert.deepEqual(imported.documentAssets, snapshot.documentAssets);
  assert.deepEqual(
    flattenLessons(imported.learningPlan?.modules)[0]?.generatedVisuals,
    flattenLessons(snapshot.learningPlan?.modules)[0]?.generatedVisuals
  );
  assert.deepEqual(
    decoded.assets.map(asset => asset.ref.id),
    [...assets.keys()].sort()
  );
  assert.deepEqual(decoded.cover, cover);
});

test('project archive v2 rejects modified durable asset bytes', async () => {
  const { assets, snapshot } = await buildAssetSnapshot();
  const archive = await createProjectArchiveBlob(snapshot, {
    loadAsset: async ref => assets.get(ref.id) || new Uint8Array(),
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifest = JSON.parse((await zip.file('project.json')?.async('string')) || '{}') as {
    attachments: { assets: Array<{ path: string }> };
  };
  zip.file(manifest.attachments.assets[0]?.path || '', new Uint8Array([9, 9, 9]));
  const modified = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  assert.equal(await isProjectArchiveFile(modified), true);
  await assert.rejects(() => decodeArchive(modified), /asset.*non valido/iu);
});

test('project archive preserves the established cover size limit', async () => {
  const oversizedCover = {
    data: encodeBytesBase64(new Uint8Array(PROJECT_COVER_MAX_BYTES + 1)),
    mimeType: 'image/png',
    name: 'cover.png',
  };

  await assert.rejects(
    () => createProjectArchiveBlob(buildPdfSnapshot(), { cover: oversizedCover }),
    /copertina.*dimensione massima/iu
  );
  await assert.rejects(
    () =>
      createProjectArchiveBlob(buildPdfSnapshot(), {
        cover: { data: encodeTextBase64('<svg />'), mimeType: 'image/svg+xml', name: 'cover.svg' },
      }),
    /formato.*copertina.*non è supportato/iu
  );
});

test('project archive v1 remains an explicit source-only import path', async () => {
  const archive = await createProjectArchiveBlob(buildPdfSnapshot());
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifest = JSON.parse((await zip.file('project.json')?.async('string')) || '{}') as {
    archiveVersion: number;
    attachments?: { assets?: unknown };
  };
  manifest.archiveVersion = 1;
  if (manifest.attachments) delete manifest.attachments.assets;
  zip.file('project.json', JSON.stringify(manifest));
  const legacy = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  const imported = (await decodeArchive(legacy)).project;
  assert.equal(imported.id, 'project-pdf');
});

test('project archive v1 rejects v2-only cover attachments', async () => {
  const archive = await createProjectArchiveBlob(buildPdfSnapshot(), {
    cover: {
      data: encodeTextBase64('cover bytes'),
      mimeType: 'image/png',
      name: 'cover.png',
    },
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('project.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    archiveVersion: number;
    attachments?: { assets?: unknown };
  };
  manifest.archiveVersion = 1;
  if (manifest.attachments) delete manifest.attachments.assets;
  zip.file('project.json', JSON.stringify(manifest));
  const invalidArchive = new Blob([
    new Uint8Array(await zip.generateAsync({ type: 'uint8array' })),
  ]);

  await assert.rejects(
    () => decodeArchive(invalidArchive),
    /backup v1.*allegati.*versioni successive/iu
  );
});

test('project archive v1 rejects files not declared by its source attachments', async () => {
  const archive = await createProjectArchiveBlob(buildPdfSnapshot());
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('project.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    archiveVersion: number;
    attachments?: { assets?: unknown };
  };
  manifest.archiveVersion = 1;
  if (manifest.attachments) delete manifest.attachments.assets;
  zip.file('project.json', JSON.stringify(manifest));
  zip.file('undeclared.bin', new Uint8Array([1, 2, 3]));
  const invalidArchive = new Blob([
    new Uint8Array(await zip.generateAsync({ type: 'uint8array' })),
  ]);

  await assert.rejects(
    () => decodeArchive(invalidArchive),
    /file non dichiarato undeclared\.bin/iu
  );
});

test('project archive v1 normalizes legacy YouTube transcript ranges and re-exports canonical segments', async () => {
  const snapshot = buildPdfSnapshot();
  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('project.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    archiveVersion: number;
    attachments?: { assets?: unknown };
    project: Record<string, unknown>;
  };
  manifest.archiveVersion = 1;
  if (manifest.attachments) delete manifest.attachments.assets;
  manifest.project.researchDossiersBySectionId = {
    'lesson-1': {
      sources: [
        {
          title: 'Video sorgente',
          youtubeTranscript: {
            ranges: [
              { endSeconds: 3, startSeconds: 1 },
              { endSeconds: 5, startSeconds: 2 },
            ],
            text: '[00:01-00:03] Primo cue\n[00:02-00:05] Cue sovrapposto',
          },
        },
      ],
    },
  };
  zip.file('project.json', JSON.stringify(manifest));
  const legacy = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  const normalized = normalizeImportedProject((await decodeArchive(legacy)).project);
  const exported = exportProjectData(normalized);
  const transcript =
    exported.researchDossiersBySectionId?.['lesson-1']?.sources[0]?.youtubeTranscript;

  assert.deepEqual(transcript, {
    segments: [
      { endSeconds: 3, startSeconds: 1, text: 'Primo cue' },
      { endSeconds: 5, startSeconds: 2, text: 'Cue sovrapposto' },
    ],
  });
  assert.equal(JSON.stringify(exported).includes('"ranges"'), false);
});

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

  const imported = (await decodeArchive(archive)).project;

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
  const imported = (await decodeArchive(archive)).project;

  assert.ok(sourceEntry);
  assert.equal(manifestText.includes(snapshot.source.file.data), false);
  assert.deepEqual(new Uint8Array(await sourceEntry.async('uint8array')), sourceBytes);
  assert.deepEqual(imported.source, snapshot.source);
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
  const imported = (await decodeArchive(archive)).project;

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
    () => decodeArchive(invalidArchive),
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
    () => decodeArchive(invalidArchive),
    /Archivio backup non valido: allegati delle fonti incompleti\./
  );
});

test('isProjectArchiveFile rejects generic source zips and manifest inspection reports a backup-specific error', async () => {
  const zip = new JSZip();
  zip.file('src/index.ts', 'export const answer = 42;');
  const genericZip = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  assert.equal(await isProjectArchiveFile(genericZip), false);
  await assert.rejects(
    () => inspectProjectArchiveData(genericZip),
    /Questo ZIP non contiene un backup Nous valido\./
  );
});

test('manifest inspection rejects ZIP archives with unsafe paths', async () => {
  const zip = new JSZip();
  zip.file('../secret.txt', 'not allowed');
  const unsafeZip = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], {
    type: 'application/zip',
  });

  assert.equal(await isProjectArchiveFile(unsafeZip), false);
  await assert.rejects(
    () => inspectProjectArchiveData(unsafeZip),
    /Questo ZIP non contiene un backup Nous valido\./
  );
});

test('readLegacyProjectImportData supports legacy json exports', async () => {
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

  assert.deepEqual(await readLegacyProjectImportData(legacyBlob), legacyExport);
});

test('readLegacyProjectImportData rejects arbitrary json files that are not Nous backups', async () => {
  const arbitraryJson = new Blob([JSON.stringify({ ok: true, items: [] })], {
    type: 'application/json',
  });

  await assert.rejects(
    () => readLegacyProjectImportData(arbitraryJson),
    /Il file selezionato non e un backup Nous valido\./
  );
});
