import assert from 'node:assert/strict';
import { formatYouTubeTranscript } from '@shared/youtubeTranscript';
import { expect, test } from 'vitest';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import {
  buildCoverLabel,
  createProjectSnapshot,
  exportProjectData,
  inferProjectSourceKind,
  normalizeImportedProject,
  normalizeStoredProject,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  decodeTextBase64,
  encodeTextBase64,
  getProjectSourceFile,
} from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import { collectLearningArtifactPayloads } from '../../../utils/learning/artifacts.ts';

test('an explicit project title survives normalization and stays aligned with the learning plan', () => {
  const snapshot = createProjectSnapshot({
    id: 'renamed-project',
    title: 'Titolo scelto',
    learningPlan: {
      title: 'Titolo generato',
      summary: 'Sintesi',
      modules: [],
      applicationExercisePlanningStatus: 'not-run',
    },
  });

  assert.equal(snapshot.title, 'Titolo scelto');
  assert.equal(snapshot.learningPlan?.title, 'Titolo scelto');
  assert.equal(exportProjectData(snapshot).title, 'Titolo scelto');
});

test('normalizes durable PDF image references without converting them to legacy data URLs', () => {
  const imported = normalizeImportedProject({
    documentAssets: {
      imageCount: 1,
      kind: 'pdf',
      parsedAt: '2026-07-29T00:00:00.000Z',
      sourceHash: 'source-hash',
      usedImages: [
        {
          asset: {
            byteSize: 4,
            hash: 'b'.repeat(64),
            id: 'a'.repeat(64),
            mediaType: 'image/png',
          },
          id: 'pdf-image-logical-1',
          pageNumber: 2,
          sourceOrder: 1,
          textAfter: 'after',
          textBefore: 'before',
        },
      ],
    },
    id: 'durable-pdf-images',
    version: '4.1',
  });

  assert.deepEqual(imported.documentAssets?.usedImages, [
    {
      asset: {
        byteSize: 4,
        hash: 'b'.repeat(64),
        id: 'a'.repeat(64),
        mediaType: 'image/png',
      },
      caption: undefined,
      id: 'pdf-image-logical-1',
      intrinsicHeight: undefined,
      intrinsicWidth: undefined,
      pageNumber: 2,
      sourceOrder: 1,
      textAfter: 'after',
      textBefore: 'before',
      textCurrent: '',
    },
  ]);
});

test('keeps a selected durable PDF image renderable across export and reload', () => {
  const image = {
    asset: {
      byteSize: 4,
      hash: 'b'.repeat(64),
      id: 'a'.repeat(64),
      mediaType: 'image/png',
    },
    id: 'pdf-image-logical-1',
    sourceOrder: 1,
    textAfter: 'after',
    textBefore: 'before',
  };
  const snapshot = createProjectSnapshot({
    documentAssets: {
      imageCount: 1,
      kind: 'pdf',
      parsedAt: '2026-07-29T00:00:00.000Z',
      usedImages: [image],
    },
    id: 'durable-pdf-reload',
    learningPlan: {
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          children: [
            {
              content: '{{PDF_IMAGE:pdf-image-logical-1}}',
              description: 'Descrizione',
              id: 'lesson-1',
              imageRefs: [{ alt: 'Schema persistito', assetId: image.id }],
              isCompleted: false,
              kind: 'lesson',
              title: 'Lezione',
              type: 'core',
            },
          ],
          id: 'module-1',
          title: 'Modulo',
        },
      ],
      summary: 'Sintesi',
      title: 'Corso',
    },
  });

  const wireSnapshot = JSON.parse(JSON.stringify(exportProjectData(snapshot)));
  const reopened = normalizeStoredProject(wireSnapshot);
  const [artifact] = collectLearningArtifactPayloads({ snapshot: reopened });

  expect(reopened.documentAssets?.usedImages[0]).toEqual({
    ...image,
    caption: undefined,
    intrinsicHeight: undefined,
    intrinsicWidth: undefined,
    pageNumber: undefined,
    textCurrent: '',
  });
  expect(artifact && 'image' in artifact ? artifact.image.id : undefined).toBe(image.id);
  expect(
    artifact && 'image' in artifact && 'asset' in artifact.image ? artifact.image.asset : undefined
  ).toEqual(image.asset);
});

test('modern archive exports round-trip raw bytes, storage reference, and the complete index', () => {
  const snapshot = createProjectSnapshot({
    id: 'archive-project',
    source: {
      file: {
        data: encodeTextBase64('raw zip bytes'),
        mimeType: 'application/zip',
        name: 'engine.zip',
      },
      index: {
        entries: [
          { kind: 'directory', path: 'docs' },
          {
            byteSize: 19,
            contentKind: 'text',
            hash: 'readme-hash',
            kind: 'file',
            path: 'docs/README.md',
            preview: '# Engine\nArchitecture',
          },
          {
            byteSize: 2048,
            contentKind: 'binary',
            hash: 'texture-hash',
            kind: 'file',
            path: 'textures/logo.png',
          },
          {
            byteSize: 1024,
            contentKind: 'binary',
            hash: 'pdf-hash',
            kind: 'file',
            path: 'scans/manual.pdf',
            warningReason: 'timeout',
          },
        ],
      },
      kind: 'archive',
      name: 'engine.zip',
      ref: {
        byteSize: 13,
        hash: 'archive-hash',
        id: 'archive-source',
        mimeType: 'application/zip',
        name: 'engine.zip',
        objectPath: 'users/user/projects/project/archive-source/original',
      },
    },
  });

  const imported = normalizeImportedProject(exportProjectData(snapshot));

  assert.deepEqual(imported.source, snapshot.source);
  assert.equal(inferProjectSourceKind(imported, true), 'codebase');
  assert.equal(getProjectSourceFile(imported.source)?.data, snapshot.source?.file.data);
});

test('modern multi-source snapshots preserve every detached storage reference', () => {
  const descriptors = buildCourseSourceDescriptors([
    {
      data: encodeTextBase64('first source'),
      mimeType: 'text/plain',
      name: 'notes.txt',
    },
    {
      data: encodeTextBase64('second source'),
      mimeType: 'text/plain',
      name: 'notes.txt',
    },
  ]).map((descriptor, position) => ({
    ...descriptor,
    file: { ...descriptor.file, data: '' },
    ref: {
      byteSize: position + 1,
      hash: `${position}`.repeat(64),
      id: descriptor.id,
      mimeType: descriptor.file.mimeType,
      name: descriptor.name,
      objectPath: `users/user/projects/project/${descriptor.id}/original`,
    },
  }));
  const snapshot = createProjectSnapshot({
    id: 'multi-source-project',
    source: {
      file: descriptors[0].file,
      kind: 'document',
      ref: descriptors[0].ref,
      sources: descriptors,
    },
  });

  const imported = normalizeImportedProject(exportProjectData(snapshot));

  assert.deepEqual(
    imported.source?.sources?.map(source => source.ref),
    descriptors.map(source => source.ref)
  );
  assert.ok(imported.source?.sources?.every(source => source.file.data === ''));
  assert.deepEqual(
    imported.source?.sources?.flatMap(source =>
      source.documentIndex?.chunks.map(chunk => chunk.text)
    ),
    ['first source', 'second source']
  );
});

test('rejects a detached source set instead of silently dropping a descriptor without a ref', () => {
  assert.throws(
    () =>
      normalizeImportedProject({
        id: 'invalid-multi-source',
        version: '4.1',
        source: {
          file: {
            data: '',
            mimeType: 'text/plain',
            name: 'first.txt',
            sourceId: 'source-first',
          },
          kind: 'document',
          ref: {
            byteSize: 1,
            hash: 'a'.repeat(64),
            id: 'source-first',
            mimeType: 'text/plain',
            name: 'first.txt',
            objectPath: 'users/user/projects/project/source-first/original',
          },
          sources: [
            {
              file: {
                data: '',
                mimeType: 'text/plain',
                name: 'first.txt',
                sourceId: 'source-first',
              },
              hash: 'a'.repeat(64),
              id: 'source-first',
              kind: 'text',
              name: 'first.txt',
              outline: [],
              outlineOrigin: 'none',
              position: 0,
              ref: {
                byteSize: 1,
                hash: 'a'.repeat(64),
                id: 'source-first',
                mimeType: 'text/plain',
                name: 'first.txt',
                objectPath: 'users/user/projects/project/source-first/original',
              },
              status: 'ready',
            },
            {
              file: {
                data: '',
                mimeType: 'text/plain',
                name: 'second.txt',
                sourceId: 'source-second',
              },
              hash: 'b'.repeat(64),
              id: 'source-second',
              kind: 'text',
              name: 'second.txt',
              outline: [],
              outlineOrigin: 'none',
              position: 1,
              status: 'ready',
            },
          ],
        },
        learningPlan: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
      }),
    /descrittore sorgente non valido/iu
  );
});

test('normalizeImportedProject preserves validated YouTube clip evidence', () => {
  const imported = normalizeImportedProject({
    id: 'video-course',
    isLearnMode: true,
    researchDossiersBySectionId: {
      lesson: {
        sectionId: 'lesson',
        title: 'Ombreggiatura',
        sources: [
          {
            sourceId: 'source-video',
            title: 'Dimostrazione valida',
            url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
            youtubeTranscript: {
              ranges: [{ startSeconds: 65, endSeconds: 93 }],
              text: '[01:05-01:33] Traccio le linee di ombra.',
            },
            videoClip: { startSeconds: 65.8, endSeconds: 92.2 },
          },
          {
            title: 'Intervallo lungo',
            url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
            videoClip: { startSeconds: 10, endSeconds: 400 },
          },
        ],
      },
    },
  });

  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.sources[0]?.videoClip, {
    startSeconds: 65,
    endSeconds: 92,
  });
  assert.equal(imported.researchDossiersBySectionId?.lesson?.sources[0]?.sourceId, 'source-video');
  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.sources[0]?.youtubeTranscript, {
    segments: [{ startSeconds: 65, endSeconds: 93, text: 'Traccio le linee di ombra.' }],
  });
  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.sources[1]?.videoClip, {
    startSeconds: 10,
    endSeconds: 400,
  });
});

test('new exports keep one inspectable transcript representation and round-trip overlapping cues', () => {
  const realisticSegmentCount = 1_529;
  const segments = Array.from({ length: realisticSegmentCount }, (_, index) => ({
    endSeconds: index * 4 + 6,
    startSeconds: index * 4,
    text: `Cue numero ${index + 1}`,
  }));
  const snapshot = normalizeImportedProject({
    id: 'video-export-v2',
    researchDossiersBySectionId: {
      lesson: {
        sectionId: 'lesson',
        sources: [
          {
            title: 'Lezione lunga',
            url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
            youtubeTranscript: { segments },
          },
        ],
        title: 'Lezione',
      },
    },
  });

  const exported = exportProjectData(snapshot);
  const transcript =
    normalizeImportedProject(exported).researchDossiersBySectionId?.lesson?.sources[0]
      ?.youtubeTranscript;
  assert.deepEqual(transcript, { segments });
  assert.equal(Object.hasOwn(transcript ?? {}, 'text'), false);
  assert.equal(Object.hasOwn(transcript ?? {}, 'ranges'), false);
  assert.deepEqual(
    normalizeImportedProject(exported).researchDossiersBySectionId?.lesson?.sources[0]
      ?.youtubeTranscript,
    { segments }
  );

  const legacyTranscript = {
    ranges: segments.map(({ endSeconds, startSeconds }) => ({ endSeconds, startSeconds })),
    text: formatYouTubeTranscript(segments),
  };
  const encodedBytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const canonicalBytes = encodedBytes(transcript);
  const legacyBytes = encodedBytes(legacyTranscript);

  assert.ok(
    canonicalBytes < legacyBytes,
    `expected segment-only transcript (${canonicalBytes} bytes) to be smaller than legacy transcript (${legacyBytes} bytes)`
  );
});

test('normalizeImportedProject preserves YouTube research decisions and rationale', () => {
  const imported = normalizeImportedProject({
    id: 'video-research-trace',
    researchDossiersBySectionId: {
      lesson: {
        sectionId: 'lesson',
        title: 'Ombreggiatura',
        youtubeResearch: {
          outcome: 'completed',
          rationale: 'Una dimostrazione pratica è pertinente.',
          candidateDecisions: [
            {
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              decision: 'selected-source',
              reason: 'Mostra il passaggio con timestamp verificati.',
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.youtubeResearch, {
    outcome: 'completed',
    rationale: 'Una dimostrazione pratica è pertinente.',
    candidateDecisions: [
      {
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        decision: 'selected-source',
        reason: 'Mostra il passaggio con timestamp verificati.',
      },
    ],
  });
});

test('detached PDF snapshots retain their source reference without pretending bytes are loaded', () => {
  const snapshot = normalizeImportedProject({
    id: 'detached-pdf',
    version: '4.1',
    source: {
      kind: 'pdf',
      file: {
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        data: '',
      },
      ref: {
        id: 'source-123',
        hash: 'hash-123',
        byteSize: 1024,
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        objectPath: 'users/user/projects/project/source-123/original',
      },
    },
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.deepEqual(snapshot.source?.kind === 'pdf' ? snapshot.source.ref : null, {
    id: 'source-123',
    hash: 'hash-123',
    byteSize: 1024,
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    objectPath: 'users/user/projects/project/source-123/original',
  });
  assert.equal(getProjectSourceFile(snapshot.source), null);
});

test('inferProjectSourceKind treats single text files as documents', () => {
  const source = createProjectSourceFromFile({
    name: 'notes.md',
    mimeType: 'text/markdown',
    data: encodeTextBase64('# Notes'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'document');
  assert.equal(
    buildCoverLabel({ source, learningPlan: null, isLearnMode: false }, 'document'),
    'notes.md'
  );
});

test('exportProjectData keeps the source only once for modern exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: {
      kind: 'pdf',
      file: pdfFile,
    },
    learningPlan: null,
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

  const exported = exportProjectData(snapshot);

  assert.deepEqual(exported.source, snapshot.source);
  assert.equal(Object.hasOwn(exported, 'file'), false);
  assert.equal(exported.createdAt, snapshot.createdAt);
  assert.equal(exported.updatedAt, snapshot.updatedAt);
  assert.equal(exported.lastOpenedAt, snapshot.lastOpenedAt);
});

test('legacy aggregate-only codebase sources are recovered without false file provenance', () => {
  const imported = normalizeImportedProject({
    id: 'legacy-project',
    source: {
      aggregatedText: '# Legacy source',
      files: [],
      kind: 'codebase-bundle',
      name: 'legacy.zip',
    },
  });

  assert.equal(imported.source?.kind, 'document');
  assert.equal(imported.source?.file.name.includes('legacy.zip'), false);
  assert.equal(decodeTextBase64(imported.source?.file.data ?? ''), '# Legacy source');
  assert.equal(imported.source?.sources?.[0]?.status, 'partial');
});

test('legacy codebase sources without files or aggregate text fail explicitly', () => {
  assert.throws(
    () =>
      normalizeImportedProject({
        id: 'legacy-project',
        source: { files: [], kind: 'codebase-bundle', name: 'legacy.zip' },
      }),
    /senza contenuto recuperabile/iu
  );
});

test('an invalid archive index rejects the whole source instead of silently dropping entries', () => {
  assert.throws(
    () =>
      normalizeImportedProject({
        source: {
          file: {
            data: encodeTextBase64('raw zip bytes'),
            mimeType: 'application/zip',
            name: 'broken.zip',
          },
          index: {
            entries: [
              { kind: 'directory', path: 'src' },
              {
                byteSize: -1,
                contentKind: 'text',
                kind: 'file',
                path: 'src/index.ts',
                preview: 'export {};',
              },
            ],
          },
          kind: 'archive',
          name: 'broken.zip',
        },
        learningPlan: {
          applicationExercisePlanningStatus: 'not-run',
          modules: [],
          summary: '',
          title: 'Corso preservato',
        },
      }),
    /sorgente archivio non valida/iu
  );
});

test('normalizeImportedProject preserves multi-source identities, outlines, and chunk provenance', () => {
  const descriptors = buildCourseSourceDescriptors([
    {
      name: 'second.txt',
      mimeType: 'text/plain',
      data: encodeTextBase64('Second source'),
    },
    {
      name: 'first.md',
      mimeType: 'text/markdown',
      data: encodeTextBase64('# First\nFirst source'),
    },
  ]);
  const source = createProjectSourceFromDescriptors(descriptors);
  const imported = normalizeImportedProject({
    version: '4.1',
    source,
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.deepEqual(
    imported.source?.sources?.map(item => ({ id: item.id, name: item.name, file: item.file })),
    descriptors.map(item => ({ id: item.id, name: item.name, file: item.file }))
  );
  assert.deepEqual(
    imported.source?.sources?.flatMap(item => item.documentIndex?.sourceIds || []),
    descriptors.map(item => item.id)
  );
  assert.equal(imported.source?.sources?.[0]?.outline[0]?.title, 'First');
});
