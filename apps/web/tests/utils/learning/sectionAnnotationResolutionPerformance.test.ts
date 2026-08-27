import { expect, test, vi } from 'vitest';

const buildVisibleProjectionCall = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/markdown/textProjection.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../utils/markdown/textProjection.ts')>();
  return {
    ...actual,
    buildVisibleProjection: (...args: Parameters<typeof actual.buildVisibleProjection>) => {
      buildVisibleProjectionCall();
      return actual.buildVisibleProjection(...args);
    },
  };
});

import type { SectionAnnotation } from '../../../types.ts';
import {
  resolveSectionAnnotationSegmentEntries,
  resolveSectionAnnotationSegments,
} from '../../../utils/learning/sectionAnnotationAnchors.ts';
import {
  applySectionAnnotation,
  findSectionAnnotationForSelection,
} from '../../../utils/learning/sectionAnnotations.ts';

const CONTENT = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

const createAnnotation = (exact: string): SectionAnnotation => {
  const start = CONTENT.indexOf(exact);
  return {
    anchor: {
      kind: 'selection',
      selector: { end: start + exact.length, exact, prefix: '', start, suffix: '' },
    },
    createdAt: '2026-08-27T00:00:00.000Z',
    id: `annotation-${exact}`,
    note: '',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
};

const FEW_ANNOTATIONS = [createAnnotation('alpha')];
const MANY_ANNOTATIONS = [
  createAnnotation('alpha'),
  createAnnotation('bravo'),
  createAnnotation('charlie'),
  createAnnotation('delta'),
  createAnnotation('echo'),
  createAnnotation('foxtrot'),
  createAnnotation('golf'),
];

const countProjectionBuilds = (operation: () => unknown): number => {
  buildVisibleProjectionCall.mockClear();
  operation();
  return buildVisibleProjectionCall.mock.calls.length;
};

test('batched annotation resolution preserves the individual resolver output', () => {
  const batch = resolveSectionAnnotationSegmentEntries(CONTENT, MANY_ANNOTATIONS);
  const individual = MANY_ANNOTATIONS.map(annotation => ({
    annotation,
    segments: resolveSectionAnnotationSegments(CONTENT, annotation),
  }));

  expect(batch).toEqual(individual);
});

test('applying an annotation builds a constant number of Markdown projections', () => {
  const apply = (annotations: SectionAnnotation[]) =>
    applySectionAnnotation({
      annotations,
      content: CONTENT,
      createId: () => 'annotation-lima',
      now: '2026-08-27T00:00:00.000Z',
      selectedText: 'lima',
      selectedTextStart: CONTENT.indexOf('lima'),
    });

  const fewProjectionBuilds = countProjectionBuilds(() => apply(FEW_ANNOTATIONS));
  const manyProjectionBuilds = countProjectionBuilds(() => apply(MANY_ANNOTATIONS));

  expect(fewProjectionBuilds).toBeGreaterThan(0);
  expect(manyProjectionBuilds).toBe(fewProjectionBuilds);
});

test('matching a selection builds a constant number of Markdown projections', () => {
  const targetAnnotation = createAnnotation('hotel');
  const find = (annotations: SectionAnnotation[]) =>
    findSectionAnnotationForSelection({
      annotations,
      content: CONTENT,
      selectedText: 'hotel',
      selectedTextStart: CONTENT.indexOf('hotel'),
    });

  const fewProjectionBuilds = countProjectionBuilds(() => find([targetAnnotation]));
  const manyProjectionBuilds = countProjectionBuilds(() =>
    find([...MANY_ANNOTATIONS, targetAnnotation])
  );

  expect(fewProjectionBuilds).toBeGreaterThan(0);
  expect(manyProjectionBuilds).toBe(fewProjectionBuilds);
});
