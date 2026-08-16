import assert from 'node:assert/strict';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from '@shared/lessonSourceContext';
import { test } from 'vitest';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import type { LessonNode, PdfTextIndex, ProjectSource } from '../../../types.ts';
import {
  buildContextSourceMaterial,
  getLessonSourcePageLabel,
  resolveLessonSourceReferences,
} from '../../../utils/context/sourceMaterial.ts';

test('returns the complete archive index in deterministic path order without concatenated content', () => {
  const source: ProjectSource = {
    file: {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: {
      entries: [
        {
          byteSize: 2048,
          contentKind: 'binary',
          kind: 'file',
          path: 'textures/logo.png',
        },
        { kind: 'directory', path: 'docs' },
        {
          byteSize: 32,
          contentKind: 'text',
          hash: 'readme-hash',
          kind: 'file',
          path: 'docs/README.md',
          preview: '# Engine\nArchitecture',
        },
      ],
    },
    kind: 'archive',
    name: 'engine.zip',
  };

  const result = buildContextSourceMaterial({
    activeSection: null,
    documentIndex: null,
    source,
  });

  assert.equal(result.sourceKind, 'archive');
  assert.equal(result.documentSourceReferences?.[0]?.name, 'engine.zip');
  assert.equal(
    result.sourceMaterial,
    [
      'directory docs',
      'file docs/README.md | text | 32 bytes | sha256 readme-hash',
      'preview:',
      '# Engine',
      'Architecture',
      'file textures/logo.png | binary | 2048 bytes',
    ].join('\n')
  );
});

test('returns lesson-relevant pdf chunks when document index is available', () => {
  const source: ProjectSource = {
    kind: 'pdf',
    file: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: 'ZmFrZQ==',
    },
  };
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
      },
    ],
  };

  const result = buildContextSourceMaterial({
    activeSection,
    documentIndex,
    source,
  });

  assert.equal(result.sourceKind, 'pdf');
  assert.equal(result.documentSourceReferences?.[0]?.name, 'dispensa.pdf');
  assert.match(result.sourceMaterial ?? '', /CHUNK chunk-002/);
  assert.match(result.sourceMaterial ?? '', /Contesto principale/);
});

test('getLessonSourcePageLabel uses the primary lesson chunks page span', () => {
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002', 'chunk-003'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    pageCount: 30,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
        pageStart: 2,
        pageEnd: 2,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
        pageStart: 10,
        pageEnd: 11,
      },
      {
        id: 'chunk-003',
        text: 'Approfondimento',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 2,
        startOffset: 35,
        endOffset: 55,
        pageStart: 12,
        pageEnd: 12,
      },
    ],
  };

  assert.equal(
    getLessonSourcePageLabel({
      activeSection,
      documentIndex,
    }),
    'pag. 10-12'
  );
});

test('getLessonSourcePageLabel keeps discontinuous source ranges visible', () => {
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002', 'chunk-003'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    pageCount: 30,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
        pageStart: 2,
        pageEnd: 2,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
        pageStart: 10,
        pageEnd: 12,
      },
      {
        id: 'chunk-003',
        text: 'Approfondimento lontano',
        headingPath: ['Appendice'],
        sequence: 2,
        startOffset: 35,
        endOffset: 55,
        pageStart: 18,
        pageEnd: 20,
      },
    ],
  };

  assert.equal(
    getLessonSourcePageLabel({
      activeSection,
      documentIndex,
    }),
    'pag. 10-12, 18-20'
  );
});

test('context provenance keeps the final original PDF among 49 numbered sources', () => {
  const descriptors = buildCourseSourceDescriptors(
    Array.from({ length: 49 }, (_, index) => ({
      data: 'JVBERi0xLjQ=',
      mimeType: 'application/pdf',
      name: `${String(index + 1).padStart(index === 48 ? 3 : 2, '0')}.pdf`,
    }))
  );
  const finalSource = descriptors.find(descriptor => descriptor.name === '049.pdf');
  const activeSection: LessonNode = {
    id: 'lesson-final-source',
    kind: 'lesson',
    title: 'Lezione finale',
    description: 'Usa la fonte finale senza fonderla con le precedenti.',
    isCompleted: false,
    type: 'core',
    sourceReferences: [
      {
        chunkIds: ['chunk-049-a', 'chunk-049-b'],
        pageEnd: 12,
        pageStart: 11,
        sourceId: finalSource?.id || '',
      },
    ],
  };
  const source = createProjectSourceFromDescriptors(descriptors);
  const documentIndex: PdfTextIndex = {
    chunks: [
      {
        endOffset: 10,
        headingPath: [],
        id: 'chunk-049-a',
        pageEnd: 11,
        pageStart: 11,
        sequence: 0,
        sourceId: finalSource?.id,
        startOffset: 0,
        text: 'Penultima sezione della fonte finale',
      },
      {
        endOffset: 20,
        headingPath: [],
        id: 'chunk-049-b',
        pageEnd: 12,
        pageStart: 12,
        sequence: 1,
        sourceId: finalSource?.id,
        startOffset: 11,
        text: 'Conclusione della fonte finale',
      },
    ],
    kind: 'pdf-text-index',
    pageCount: 12,
    parsedAt: '2026-08-15T10:00:00.000Z',
  };

  const references = resolveLessonSourceReferences({
    activeSection,
    source,
  });
  const context = buildContextSourceMaterial({ activeSection, documentIndex, source });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, '049.pdf');
  assert.equal(references[0]?.sourceId, finalSource?.id);
  assert.equal(references[0]?.pageStart, 11);
  assert.equal(references[0]?.pageEnd, 12);
  assert.deepEqual(references[0]?.chunkIds, ['chunk-049-a', 'chunk-049-b']);
  assert.equal(context.documentSourceReferences?.[0]?.file.data, '');
  assert.deepEqual(context.documentSourceReferences?.[0]?.chunkIds, references[0]?.chunkIds);
});

test('resolveLessonSourceReferences links legacy chunk provenance to the only document source', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: '', mimeType: 'application/pdf', name: 'legacy.pdf' },
  ]);
  const activeSection: LessonNode = {
    description: 'Lezione salvata prima dei riferimenti multisorgente.',
    id: 'legacy-pdf-lesson',
    isCompleted: true,
    kind: 'lesson',
    primaryChunkIds: ['chunk-022', 'chunk-023'],
    title: 'Lezione legacy',
    type: 'core',
  };

  const references = resolveLessonSourceReferences({
    activeSection,
    source: createProjectSourceFromDescriptors(descriptors),
  });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.sourceId, descriptors[0]?.id);
  assert.equal(references[0]?.name, 'legacy.pdf');
  assert.deepEqual(references[0]?.chunkIds, ['chunk-022', 'chunk-023']);
});

test('resolveLessonSourceReferences does not guess a legacy source in multisource courses', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: '', mimeType: 'application/pdf', name: 'one.pdf' },
    { data: '', mimeType: 'application/pdf', name: 'two.pdf' },
  ]);
  const activeSection: LessonNode = {
    description: 'Riferimento sorgente non disponibile.',
    id: 'legacy-multisource-lesson',
    isCompleted: true,
    kind: 'lesson',
    primaryChunkIds: ['chunk-022'],
    title: 'Lezione multisorgente legacy',
    type: 'core',
  };

  assert.deepEqual(
    resolveLessonSourceReferences({
      activeSection,
      source: createProjectSourceFromDescriptors(descriptors),
    }),
    []
  );
});

test('buildContextSourceMaterial derives fallback provenance from the chunks it sends', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'Zmlyc3Q=', mimeType: 'application/pdf', name: 'one.pdf' },
    { data: 'c2Vjb25k', mimeType: 'application/pdf', name: 'two.pdf' },
  ]);
  const documentIndex: PdfTextIndex = {
    chunks: descriptors.map((descriptor, sequence) => ({
      endOffset: sequence + 1,
      headingPath: [],
      id: `${descriptor.id}:chunk-${sequence + 1}`,
      pageEnd: sequence + 4,
      pageStart: sequence + 4,
      sequence,
      sourceId: descriptor.id,
      startOffset: sequence,
      text: `Contenuto ${descriptor.name}`,
    })),
    kind: 'pdf-text-index',
    pageCount: 10,
    parsedAt: '2026-08-15T10:00:00.000Z',
  };

  const context = buildContextSourceMaterial({
    activeSection: null,
    documentIndex,
    source: createProjectSourceFromDescriptors(descriptors),
  });

  assert.deepEqual(
    context.documentSourceReferences?.map(reference => ({
      chunks: reference.chunkIds,
      data: reference.file.data,
      name: reference.name,
      pageStart: reference.pageStart,
    })),
    [
      {
        chunks: [`${descriptors[0]?.id}:chunk-1`],
        data: '',
        name: 'one.pdf',
        pageStart: 4,
      },
      {
        chunks: [`${descriptors[1]?.id}:chunk-2`],
        data: '',
        name: 'two.pdf',
        pageStart: 5,
      },
    ]
  );
  assert.match(context.sourceMaterial || '', /Contenuto one\.pdf/u);
  assert.match(context.sourceMaterial || '', /Contenuto two\.pdf/u);
});

test('buildContextSourceMaterial derives provenance after retaining complete prompt chunks', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'Zmlyc3Q=', mimeType: 'application/pdf', name: 'first.pdf' },
    { data: 'c2Vjb25k', mimeType: 'application/pdf', name: 'second.pdf' },
  ]);
  const documentIndex: PdfTextIndex = {
    chunks: descriptors.map((descriptor, sequence) => ({
      endOffset: sequence + 1,
      headingPath: [],
      id: `${descriptor.id}:chunk-${sequence + 1}`,
      sequence,
      sourceId: descriptor.id,
      startOffset: sequence,
      text: sequence === 0 ? 'a'.repeat(MAX_CONTEXT_CHAT_FIELD_CHARS / 2) : 'b'.repeat(13_000),
    })),
    kind: 'pdf-text-index',
    parsedAt: '2026-08-15T10:00:00.000Z',
  };

  const context = buildContextSourceMaterial({
    activeSection: null,
    documentIndex,
    source: createProjectSourceFromDescriptors(descriptors),
  });

  assert.deepEqual(
    context.documentSourceReferences?.map(reference => reference.name),
    ['first.pdf']
  );
  assert.match(context.sourceMaterial || '', /CHUNK .*chunk-1/u);
  assert.doesNotMatch(context.sourceMaterial || '', /chunk-2/u);
  assert.ok((context.sourceMaterial?.length || 0) <= MAX_CONTEXT_CHAT_FIELD_CHARS);
});

test('resolveLessonSourceReferences normalizes missing legacy chunk IDs', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: '', mimeType: 'application/pdf', name: 'legacy.pdf' },
  ]);
  const activeSection = {
    description: 'Lezione importata.',
    id: 'legacy-reference',
    isCompleted: true,
    kind: 'lesson',
    sourceReferences: [{ sourceId: descriptors[0]?.id }],
    title: 'Legacy',
    type: 'core',
  } as LessonNode;

  const references = resolveLessonSourceReferences({
    activeSection,
    source: createProjectSourceFromDescriptors(descriptors),
  });

  assert.deepEqual(references[0]?.chunkIds, []);
});

test('resolveLessonSourceReferences restores the original archive and exact lesson selectors', () => {
  const source: ProjectSource = {
    file: {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'src.zip',
    },
    index: {
      entries: [
        { kind: 'directory', path: 'luanti/src' },
        {
          byteSize: 128,
          contentKind: 'text',
          kind: 'file',
          path: 'luanti/src/client.cpp',
        },
      ],
    },
    kind: 'archive',
    name: 'src.zip',
    ref: {
      byteSize: 256,
      hash: 'archive-hash',
      id: 'source-archive',
      mimeType: 'application/zip',
      name: 'src.zip',
      objectPath: 'sources/src.zip',
    },
  };
  const activeSection: LessonNode = {
    id: 'lesson-codebase',
    kind: 'lesson',
    title: 'Client',
    description: 'Architettura del client.',
    isCompleted: false,
    type: 'core',
    sourceArchiveSelectors: [
      { kind: 'file', path: 'luanti/src/client.cpp' },
      { kind: 'directory', path: 'luanti/src' },
    ],
  };

  const references = resolveLessonSourceReferences({ activeSection, source });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, 'src.zip');
  assert.equal(references[0]?.sourceId, 'source-archive');
  assert.equal(references[0]?.kind, 'archive');
  assert.deepEqual(references[0]?.archiveSelectors, activeSection.sourceArchiveSelectors);
});

test('resolveLessonSourceReferences keeps legacy archive provenance without selectors', () => {
  const source: ProjectSource = {
    file: { data: '', mimeType: 'application/zip', name: 'legacy-codebase.zip' },
    index: { entries: [] },
    kind: 'archive',
    name: 'legacy-codebase.zip',
    ref: {
      byteSize: 512,
      hash: 'legacy-hash',
      id: 'legacy-archive-source',
      mimeType: 'application/zip',
      name: 'legacy-codebase.zip',
      objectPath: 'sources/legacy-codebase.zip',
    },
  };
  const activeSection: LessonNode = {
    description: 'Lezione creata prima dei selector per archivio.',
    id: 'legacy-lesson',
    isCompleted: true,
    kind: 'lesson',
    title: 'Architettura',
    type: 'core',
  };

  const references = resolveLessonSourceReferences({ activeSection, source });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, 'legacy-codebase.zip');
  assert.equal(references[0]?.sourceId, 'legacy-archive-source');
  assert.equal(references[0]?.archiveSelectors, undefined);
});
