import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applySectionAnnotation,
  findSectionAnnotationForSelection,
  migrateSectionAnnotations,
  NOTE_MERGE_SEPARATOR,
  removeSectionAnnotation,
  updateSectionAnnotationNote,
} from './sectionAnnotations.ts';

test('applySectionAnnotation creates a persistent highlight with a stable annotation id', () => {
  const result = applySectionAnnotation({
    annotations: [],
    content: 'Alpha beta gamma delta.',
    createId: () => 'annotation-1',
    now: '2026-04-02T10:00:00.000Z',
    selectedText: 'beta',
  });

  assert.ok(result);
  assert.equal(
    result.content,
    'Alpha <mark data-lumina-annotation-id="annotation-1">beta</mark> gamma delta.'
  );
  assert.equal(result.annotationId, 'annotation-1');
  assert.deepEqual(result.annotations, [
    {
      id: 'annotation-1',
      note: '',
      createdAt: '2026-04-02T10:00:00.000Z',
      updatedAt: '2026-04-02T10:00:00.000Z',
    },
  ]);
});

test('applySectionAnnotation stores a note and merges overlapping notes into the larger selection', () => {
  const initial = applySectionAnnotation({
    annotations: [],
    content: 'Alpha beta gamma delta.',
    createId: () => 'annotation-1',
    note: 'Nota piccola',
    now: '2026-04-02T10:00:00.000Z',
    selectedText: 'beta',
  });

  assert.ok(initial);

  const merged = applySectionAnnotation({
    annotations: initial.annotations,
    content: initial.content,
    createId: () => 'annotation-2',
    note: 'Nota grande',
    now: '2026-04-02T11:00:00.000Z',
    selectedText: 'beta gamma',
  });

  assert.ok(merged);
  assert.equal(
    merged.content,
    'Alpha <mark data-lumina-annotation-id="annotation-1">beta</mark> <mark data-lumina-annotation-id="annotation-1">gamma</mark> delta.'
  );
  assert.equal(merged.merged, true);
  assert.equal(
    merged.annotations[0]?.note,
    `Nota grande${NOTE_MERGE_SEPARATOR}Nota piccola`
  );
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
    content: created.content,
    selectedText: 'beta gamma',
  });

  assert.ok(match);
  assert.equal(match.annotation.id, 'annotation-1');
  assert.equal(match.annotation.note, 'Nota esistente');
  assert.equal(match.resolvedText, 'beta gamma');
});

test('removeSectionAnnotation removes both metadata and markup', () => {
  const removed = removeSectionAnnotation({
    annotationId: 'annotation-1',
    annotations: [
      {
        id: 'annotation-1',
        note: 'Nota',
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
      },
    ],
    content: 'Alpha <mark data-lumina-annotation-id="annotation-1">beta</mark> gamma.',
  });

  assert.equal(removed.removed, true);
  assert.equal(removed.content, 'Alpha beta gamma.');
  assert.deepEqual(removed.annotations, []);
});

test('migrateSectionAnnotations converts legacy plain marks into persistent annotations', () => {
  const migrated = migrateSectionAnnotations({
    annotations: [],
    content: 'Alpha <mark>beta</mark> <mark>gamma</mark> delta.',
    createId: () => 'annotation-legacy',
    now: '2026-04-02T10:00:00.000Z',
  });

  assert.equal(migrated.didChange, true);
  assert.equal(
    migrated.content,
    'Alpha <mark data-lumina-annotation-id="annotation-legacy">beta</mark> <mark data-lumina-annotation-id="annotation-legacy">gamma</mark> delta.'
  );
  assert.deepEqual(migrated.annotations, [
    {
      id: 'annotation-legacy',
      note: '',
      createdAt: '2026-04-02T10:00:00.000Z',
      updatedAt: '2026-04-02T10:00:00.000Z',
    },
  ]);
});
