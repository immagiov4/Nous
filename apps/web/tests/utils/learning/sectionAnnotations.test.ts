import assert from 'node:assert/strict';
import { test } from 'vitest';
import { materializeSectionAnnotationMarks } from '../../../utils/learning/sectionAnnotationAnchors.ts';
import {
  applySectionAnnotation,
  createLessonSectionAnnotation,
  findSectionAnnotationForSelection,
  getSectionAnnotationText,
  NOTE_MERGE_SEPARATOR,
  removeSectionAnnotation,
  removeSectionAnnotationArtifactRef,
  updateSectionAnnotationNote,
  upsertSectionAnnotationArtifactRefs,
} from '../../../utils/learning/sectionAnnotations.ts';

test('applySectionAnnotation stores a selector without changing the Markdown', () => {
  const content = 'Alpha beta gamma delta.';
  const result = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-detached',
    now: '2026-07-14T10:00:00.000Z',
    selectedText: 'beta',
  });

  assert.ok(result);
  assert.deepEqual(result.annotations, [
    {
      anchor: {
        kind: 'selection',
        selector: {
          end: 10,
          exact: 'beta',
          prefix: 'Alpha',
          start: 6,
          suffix: 'gamma delta.',
        },
      },
      createdAt: '2026-07-14T10:00:00.000Z',
      id: 'annotation-detached',
      note: '',
      updatedAt: '2026-07-14T10:00:00.000Z',
    },
  ]);
  assert.equal(
    materializeSectionAnnotationMarks(content, result.annotations),
    'Alpha <mark data-nous-annotation-id="annotation-detached">beta</mark> gamma delta.'
  );
  assert.equal(
    getSectionAnnotationText(content, 'annotation-detached', result.annotations),
    'beta'
  );
  assert.equal(
    findSectionAnnotationForSelection({
      annotations: result.annotations,
      content,
      selectedText: 'beta',
    })?.annotation.id,
    'annotation-detached'
  );
});

test('detached annotations re-anchor by quote and context after content shifts', () => {
  const created = applySectionAnnotation({
    annotations: [],
    content: 'Alpha beta gamma delta.',
    createId: () => 'annotation-detached',
    selectedText: 'beta gamma',
  });

  assert.ok(created);
  assert.equal(
    materializeSectionAnnotationMarks(
      'Introduzione nuova. Alpha beta gamma delta.',
      created.annotations
    ),
    'Introduzione nuova. Alpha <mark data-nous-annotation-id="annotation-detached">beta gamma</mark> delta.'
  );
});

test('detached annotations stay orphaned when an ambiguous quote has no matching context', () => {
  const content = 'Beta uno. Beta due.';
  const annotations = [
    {
      anchor: {
        kind: 'selection' as const,
        selector: {
          end: 104,
          exact: 'Beta',
          prefix: 'Contesto scomparso',
          start: 100,
          suffix: 'Altro contesto scomparso',
        },
      },
      createdAt: '2026-07-14T10:00:00.000Z',
      id: 'annotation-orphaned',
      note: '',
      updatedAt: '2026-07-14T10:00:00.000Z',
    },
  ];

  assert.equal(materializeSectionAnnotationMarks(content, annotations), content);
});

test('applySectionAnnotation anchors a repeated word at the contextual occurrence', () => {
  const content = 'Beta uno. Beta due.';
  const result = applySectionAnnotation({
    annotations: [],
    content,
    contextAfter: ' due.',
    contextBefore: 'Beta uno. ',
    createId: () => 'annotation-second-beta',
    selectedText: 'Beta',
  });

  assert.ok(result);
  assert.deepEqual(result.annotations[0]?.anchor, {
    kind: 'selection',
    selector: {
      end: 14,
      exact: 'Beta',
      prefix: 'Beta uno.',
      start: 10,
      suffix: 'due.',
    },
  });
  assert.equal(
    materializeSectionAnnotationMarks(content, result.annotations),
    'Beta uno. <mark data-nous-annotation-id="annotation-second-beta">Beta</mark> due.'
  );
});

test('applySectionAnnotation rejects repeated words when the supplied context does not match', () => {
  const result = applySectionAnnotation({
    annotations: [],
    content: 'Beta uno. Beta due.',
    contextAfter: 'contesto assente',
    contextBefore: 'altro contesto assente',
    selectedText: 'Beta',
  });

  assert.equal(result, null);
});

test('applySectionAnnotation rejects repeated words when context matches multiple occurrences', () => {
  const result = applySectionAnnotation({
    annotations: [],
    content: 'Alpha Beta gamma. Alpha Beta gamma.',
    contextAfter: ' gamma.',
    contextBefore: 'Alpha ',
    selectedText: 'Beta',
  });

  assert.equal(result, null);
});

test('applySectionAnnotation uses the visible text offset when text and context are identical', () => {
  const content = 'Alpha Beta gamma. Alpha Beta gamma.';
  const selectedTextStart = content.lastIndexOf('Beta');
  const result = applySectionAnnotation({
    annotations: [],
    content,
    contextAfter: ' gamma.',
    contextBefore: 'Alpha ',
    createId: () => 'annotation-second-identical-beta',
    selectedText: 'Beta',
    selectedTextStart,
  });

  assert.equal(result?.annotations[0]?.anchor?.kind, 'selection');
  assert.deepEqual(result?.annotations[0]?.anchor, {
    kind: 'selection',
    selector: {
      end: selectedTextStart + 'Beta'.length,
      exact: 'Beta',
      prefix: 'Alpha Beta gamma. Alpha',
      start: selectedTextStart,
      suffix: 'gamma.',
    },
  });
  assert.equal(
    materializeSectionAnnotationMarks(content, result?.annotations),
    'Alpha Beta gamma. Alpha <mark data-nous-annotation-id="annotation-second-identical-beta">Beta</mark> gamma.'
  );
});

test('materialized annotations preserve inline Markdown as one highlight', () => {
  const content =
    'Prima **grassetto**, poi *corsivo* e [un link](https://example.com/percorso_(test)).';
  const created = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-inline-detached',
    selectedText: 'Prima grassetto, poi corsivo e un link',
  });

  assert.ok(created);
  assert.equal(
    materializeSectionAnnotationMarks(content, created.annotations),
    '<mark data-nous-annotation-id="annotation-inline-detached">Prima **grassetto**, poi *corsivo* e [un link](https://example.com/percorso_(test))</mark>.'
  );
});

test('applySectionAnnotation merges overlapping notes', () => {
  const content = 'Alpha beta gamma delta.';
  const initial = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-detached',
    note: 'Nota piccola',
    selectedText: 'beta',
  });

  assert.ok(initial);
  const merged = applySectionAnnotation({
    annotations: initial.annotations,
    content,
    createId: () => 'unused-id',
    note: 'Nota grande',
    selectedText: 'beta gamma',
  });

  assert.ok(merged);
  assert.equal(merged.annotationId, 'annotation-detached');
  assert.equal(merged.annotations.length, 1);
  assert.equal(merged.annotations[0]?.note, `Nota grande${NOTE_MERGE_SEPARATOR}Nota piccola`);
  assert.equal(
    merged.annotations[0]?.anchor?.kind === 'selection'
      ? merged.annotations[0].anchor.selector.exact
      : '',
    'beta gamma'
  );
});

test('applySectionAnnotation creates an anchored highlight with a stable annotation id', () => {
  const result = applySectionAnnotation({
    annotations: [],
    content: 'Alpha beta gamma delta.',
    createId: () => 'annotation-1',
    now: '2026-04-02T10:00:00.000Z',
    selectedText: 'beta',
  });

  assert.ok(result);
  assert.equal(result.annotationId, 'annotation-1');
  assert.deepEqual(result.annotations, [
    {
      anchor: {
        kind: 'selection',
        selector: {
          end: 10,
          exact: 'beta',
          prefix: 'Alpha',
          start: 6,
          suffix: 'gamma delta.',
        },
      },
      id: 'annotation-1',
      note: '',
      createdAt: '2026-04-02T10:00:00.000Z',
      updatedAt: '2026-04-02T10:00:00.000Z',
    },
  ]);
});

test('createLessonSectionAnnotation stores a lesson-level note with artifact refs', () => {
  const result = createLessonSectionAnnotation({
    annotations: [],
    artifactRefs: [
      {
        artifactId: 'project-1:lesson-1:generated-visual:visual-1',
        kind: 'generated-visual',
        title: 'Mappa concettuale',
      },
    ],
    createId: () => 'annotation-lesson',
    note: 'Nota generale della lezione',
    now: '2026-05-05T10:00:00.000Z',
  });

  assert.deepEqual(result.annotations, [
    {
      anchor: { kind: 'lesson' },
      artifactRefs: [
        {
          artifactId: 'project-1:lesson-1:generated-visual:visual-1',
          kind: 'generated-visual',
          title: 'Mappa concettuale',
        },
      ],
      createdAt: '2026-05-05T10:00:00.000Z',
      id: 'annotation-lesson',
      note: 'Nota generale della lezione',
      updatedAt: '2026-05-05T10:00:00.000Z',
    },
  ]);
});

test('upsertSectionAnnotationArtifactRefs merges artifact refs without duplicating them', () => {
  const result = upsertSectionAnnotationArtifactRefs({
    annotationId: 'annotation-1',
    annotations: [
      {
        artifactRefs: [
          {
            artifactId: 'project-1:lesson-1:generated-visual:visual-1',
            kind: 'generated-visual',
            title: 'Prima mappa',
          },
        ],
        createdAt: '2026-05-05T10:00:00.000Z',
        id: 'annotation-1',
        note: 'Nota',
        updatedAt: '2026-05-05T10:00:00.000Z',
      },
    ],
    artifactRefs: [
      {
        artifactId: 'project-1:lesson-1:generated-visual:visual-1',
        kind: 'generated-visual',
        title: 'Titolo aggiornato ignorato',
      },
      {
        artifactId: 'project-1:lesson-1:generated-visual:visual-2',
        kind: 'generated-visual',
        title: 'Seconda mappa',
      },
    ],
    now: '2026-05-05T11:00:00.000Z',
  });

  assert.ok(result);
  assert.deepEqual(result.annotation.artifactRefs, [
    {
      artifactId: 'project-1:lesson-1:generated-visual:visual-1',
      kind: 'generated-visual',
      title: 'Prima mappa',
    },
    {
      artifactId: 'project-1:lesson-1:generated-visual:visual-2',
      kind: 'generated-visual',
      title: 'Seconda mappa',
    },
  ]);
  assert.equal(result.annotation.updatedAt, '2026-05-05T11:00:00.000Z');
});

test('removeSectionAnnotationArtifactRef detaches one artifact without deleting the note', () => {
  const result = removeSectionAnnotationArtifactRef({
    annotationId: 'annotation-1',
    annotations: [
      {
        artifactRefs: [
          {
            artifactId: 'visual-1',
            kind: 'generated-visual',
            title: 'Prima mappa',
          },
          {
            artifactId: 'visual-2',
            kind: 'generated-visual',
            title: 'Seconda mappa',
          },
        ],
        createdAt: '2026-05-05T10:00:00.000Z',
        id: 'annotation-1',
        note: 'Nota',
        updatedAt: '2026-05-05T10:00:00.000Z',
      },
    ],
    artifactId: 'visual-1',
    now: '2026-05-05T11:00:00.000Z',
  });

  assert.ok(result);
  assert.deepEqual(result.annotation.artifactRefs, [
    {
      artifactId: 'visual-2',
      kind: 'generated-visual',
      title: 'Seconda mappa',
    },
  ]);
  assert.equal(result.annotation.note, 'Nota');
  assert.equal(result.annotation.updatedAt, '2026-05-05T11:00:00.000Z');
});

test('removeSectionAnnotationArtifactRef removes artifactRefs when the last attachment is detached', () => {
  const result = removeSectionAnnotationArtifactRef({
    annotationId: 'annotation-1',
    annotations: [
      {
        artifactRefs: [
          {
            artifactId: 'visual-1',
            kind: 'generated-visual',
            title: 'Prima mappa',
          },
        ],
        createdAt: '2026-05-05T10:00:00.000Z',
        id: 'annotation-1',
        note: '',
        updatedAt: '2026-05-05T10:00:00.000Z',
      },
    ],
    artifactId: 'visual-1',
    now: '2026-05-05T11:00:00.000Z',
  });

  assert.ok(result);
  assert.equal(result.annotation.artifactRefs, undefined);
  assert.equal(result.annotation.note, '');
});

test('updateSectionAnnotationNote can clear a note without removing the highlight', () => {
  const updated = updateSectionAnnotationNote({
    annotationId: 'annotation-1',
    annotations: [
      {
        id: 'annotation-1',
        note: 'Nota esistente',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
      },
    ],
    note: '   ',
    now: '2026-04-02T12:00:00.000Z',
  });

  assert.ok(updated);
  assert.equal(updated.annotation.note, '');
  assert.equal(updated.annotation.updatedAt, '2026-04-02T12:00:00.000Z');
});

test('findSectionAnnotationForSelection resolves the existing annotation for the selected passage', () => {
  const created = applySectionAnnotation({
    annotations: [],
    content: 'Alpha beta gamma delta.',
    createId: () => 'annotation-1',
    note: 'Nota esistente',
    now: '2026-04-02T10:00:00.000Z',
    selectedText: 'beta gamma',
  });

  assert.ok(created);

  const match = findSectionAnnotationForSelection({
    annotations: created.annotations,
    content: 'Alpha beta gamma delta.',
    selectedText: 'beta gamma',
  });

  assert.ok(match);
  assert.equal(match.annotation.id, 'annotation-1');
  assert.equal(match.annotation.note, 'Nota esistente');
  assert.equal(match.resolvedText, 'beta gamma');
});

test('applySectionAnnotation preserves inline math markdown while annotating the surrounding prose', () => {
  const content = 'Ridurre soprattutto $T_{\\text{cluster}}$ e $T_{\\text{update}}$ accelera.';
  const result = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-math',
    now: '2026-04-02T10:00:00.000Z',
    selectedText:
      'Ridurre soprattutto TclusterT_{\\text{cluster}}Tcluster\u200b e TupdateT_{\\text{update}}Tupdate\u200b accelera.',
  });

  assert.ok(result);
  assert.equal(
    materializeSectionAnnotationMarks(content, result.annotations),
    '<mark data-nous-annotation-id="annotation-math">Ridurre soprattutto</mark> $T_{\\text{cluster}}$ <mark data-nous-annotation-id="annotation-math">e</mark> $T_{\\text{update}}$ <mark data-nous-annotation-id="annotation-math">accelera.</mark>'
  );
  assert.equal(result.resolvedText, 'Ridurre soprattutto Tcluster e Tupdate accelera.');
});

test('applySectionAnnotation keeps one persistent highlight across inline markdown', () => {
  const content = 'Prima **grassetto**, poi *corsivo* e infine [un link](https://example.com).';
  const result = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-inline',
    now: '2026-04-02T10:00:00.000Z',
    selectedText: 'Prima grassetto, poi corsivo e infine un link.',
  });

  assert.ok(result);
  assert.equal(
    materializeSectionAnnotationMarks(content, result.annotations),
    '<mark data-nous-annotation-id="annotation-inline">Prima **grassetto**, poi *corsivo* e infine [un link](https://example.com).</mark>'
  );

  const removed = removeSectionAnnotation({
    annotationId: 'annotation-inline',
    annotations: result.annotations,
  });

  assert.equal(removed.removed, true);
  assert.deepEqual(removed.annotations, []);
});

test('applySectionAnnotation can anchor a note across display math selected via KaTeX-projected text', () => {
  const content =
    'Un modello analitico produce la soluzione:\n\n$$y(t)=\\frac{1}{2}gt^2+v_0t+y_0$$\n\nma il videogioco procede per passi.';
  const result = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-display-math',
    now: '2026-04-03T10:00:00.000Z',
    selectedText:
      'Un modello analitico produce la soluzione: y(t)=frac12gt2+v0t+y0 ma il videogioco procede per passi.',
  });

  assert.ok(result);
  assert.equal(
    materializeSectionAnnotationMarks(content, result.annotations),
    '<mark data-nous-annotation-id="annotation-display-math">Un modello analitico produce la soluzione:</mark>\n\n$$y(t)=\\frac{1}{2}gt^2+v_0t+y_0$$\n\n<mark data-nous-annotation-id="annotation-display-math">ma il videogioco procede per passi.</mark>'
  );
  assert.equal(
    result.resolvedText,
    'Un modello analitico produce la soluzione: y(t)=frac12gt2+v0t+y0 ma il videogioco procede per passi.'
  );
});

test('removeSectionAnnotation deletes anchored metadata', () => {
  const content = 'Alpha beta gamma.';
  const created = applySectionAnnotation({
    annotations: [],
    content,
    createId: () => 'annotation-detached',
    selectedText: 'beta',
  });

  assert.ok(created);
  const removed = removeSectionAnnotation({
    annotationId: 'annotation-detached',
    annotations: created.annotations,
  });

  assert.equal(removed.removed, true);
  assert.deepEqual(removed.annotations, []);
});
