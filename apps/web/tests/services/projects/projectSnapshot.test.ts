import assert from 'node:assert/strict';
import { test } from 'vitest';
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
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  encodeTextBase64,
  getProjectSourceFile,
} from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

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
  const imported = normalizeImportedProject({
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
  });

  assert.equal(imported.source, null);
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
  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.sources[0]?.youtubeTranscript, {
    ranges: [{ startSeconds: 65, endSeconds: 93 }],
    text: '[01:05-01:33] Traccio le linee di ombra.',
  });
  assert.deepEqual(imported.researchDossiersBySectionId?.lesson?.sources[1]?.videoClip, {
    startSeconds: 10,
    endSeconds: 400,
  });
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
});

test('legacy source payloads are discarded without losing their course', () => {
  const imported = normalizeImportedProject({
    version: '3.0',
    file: {
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      data: encodeTextBase64('fake-pdf-binary'),
    },
    source: {
      aggregatedText: '# Legacy source',
      files: [],
      kind: 'codebase-bundle',
      name: 'legacy.zip',
    },
    learningPlan: {
      applicationExercisePlanningStatus: 'not-run',
      modules: [],
      summary: 'Il corso resta disponibile.',
      title: 'Corso esistente',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.equal(imported.source, null);
  assert.equal(imported.learningPlan?.title, 'Corso esistente');
  assert.equal(imported.learningPlan?.summary, 'Il corso resta disponibile.');
});

test('an invalid archive index rejects the whole source instead of silently dropping entries', () => {
  const imported = normalizeImportedProject({
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
  });

  assert.equal(imported.source, null);
  assert.equal(imported.learningPlan?.title, 'Corso preservato');
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
