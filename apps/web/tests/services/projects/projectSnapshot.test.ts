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
  decodeTextBase64,
  encodeTextBase64,
  getProjectSourceFile,
} from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

test('createProjectSourceFromFile upgrades legacy zip payloads into structured codebase sources', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('--- START OF FILE: src/index.ts ---\nconsole.log("hi");'),
  });

  assert.equal(source.kind, 'codebase-bundle');
  assert.match(source.aggregatedText, /src\/index\.ts/);
});

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

test('getProjectSourceFile preserves a round-trip legacy file payload for codebase bundles', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  const file = getProjectSourceFile(source);

  assert.equal(file?.name, 'repo.zip');
  assert.equal(file?.mimeType, 'text/plain');
  assert.equal(decodeTextBase64(file?.data || ''), 'console.log("hi");');
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

test('inferProjectSourceKind keeps zip-backed codebase bundles as codebase projects', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'codebase');
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

test('normalizeImportedProject still supports legacy file-only exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };

  const imported = normalizeImportedProject({
    version: '3.0',
    file: pdfFile,
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.deepEqual(imported.source, {
    kind: 'pdf',
    file: pdfFile,
  });
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
