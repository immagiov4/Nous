import type { ProjectLessonVisual } from '@shared/projectAsset';
import type {
  LessonGeneratedVisual,
  LessonGeneratedVisualKind,
  StoredLessonVisual,
} from '../../types.ts';

const STORED_LESSON_VISUAL_KINDS: ReadonlySet<LessonGeneratedVisualKind> = new Set([
  'html',
  'image',
  'mermaid',
  'svg',
]);

export const isStoredLessonVisualKind = (value: unknown): value is LessonGeneratedVisualKind =>
  typeof value === 'string' && STORED_LESSON_VISUAL_KINDS.has(value as LessonGeneratedVisualKind);

export const isProjectLessonVisual = (visual: StoredLessonVisual): visual is ProjectLessonVisual =>
  'render' in visual;

export const getStoredLessonVisualKind = (visual: StoredLessonVisual): LessonGeneratedVisualKind =>
  isProjectLessonVisual(visual) ? visual.render.kind : visual.kind;

export const getStoredLessonVisualCode = (visual: StoredLessonVisual): string | null => {
  if (!isProjectLessonVisual(visual)) return visual.code;
  return visual.render.kind === 'image' ? null : visual.render.code;
};

export const asLegacyLessonVisual = (visual: StoredLessonVisual): LessonGeneratedVisual | null =>
  isProjectLessonVisual(visual) ? null : visual;
