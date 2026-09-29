import { memo, useLayoutEffect, useRef } from 'react';
import { useAppLocale } from '../../hooks/useAppLocale.ts';
import {
  ANNOTATION_PROJECTION_ERROR_MESSAGE,
  translateUiMessage as t,
} from '../../i18n/uiMessages.ts';
import type { LessonContentBlock, SectionAnnotation } from '../../types.ts';
import { isSelectionAnnotation } from '../../utils/learning/sectionAnnotationAnchors.ts';
import { getRenderedSectionAnnotationIds } from '../../utils/learning/sectionAnnotationHighlights.ts';

/** Mount after the lesson's Markdown blocks so their native ranges are registered. */
export default memo(function SectionAnnotationProjectionFeedback({
  annotations = [],
  content,
}: {
  readonly annotations?: SectionAnnotation[];
  readonly content: string | LessonContentBlock[];
}) {
  useAppLocale();
  const message = t(ANNOTATION_PROJECTION_ERROR_MESSAGE);
  const warningRef = useRef<HTMLDivElement>(null);
  const previousSignatureRef = useRef('');
  useLayoutEffect(() => {
    const warning = warningRef.current;
    const root = warning?.parentElement;
    if (!warning || !root) return;
    const renderedIds = getRenderedSectionAnnotationIds(root);
    const hasContent = typeof content === 'string' ? Boolean(content.trim()) : content.length > 0;
    const unresolved = (hasContent ? annotations : []).filter(
      annotation => isSelectionAnnotation(annotation) && !renderedIds.has(annotation.id)
    );
    const signature = unresolved
      .map(annotation => annotation.id)
      .sort((left, right) => left.localeCompare(right))
      .join('\n');
    if (signature && signature !== previousSignatureRef.current) {
      console.warn('[Nous][AnnotationProjection]', { unresolvedCount: unresolved.length });
    }
    previousSignatureRef.current = signature;
    warning.hidden = unresolved.length === 0;
    warning.textContent = unresolved.length > 0 ? message : '';
  }, [annotations, content, message]);
  return (
    <div
      ref={warningRef}
      hidden
      role="alert"
      data-nous-speech="ignore"
      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
    />
  );
});
