import {
  buildVisibleImageLabel,
  type PdfImageReference,
  resolvePdfImageRefs,
} from '@shared/lessonPdfImageSelection';

import type { LessonImageCandidate, LessonPdfImageAsset } from './lessonGenerationSources.js';

export {
  buildVisibleImageLabel,
  selectCandidatePdfImages,
} from '@shared/lessonPdfImageSelection';

export type LessonImageReference = PdfImageReference;

export const toImageCandidate = (
  image: LessonPdfImageAsset,
  sectionTitle: string,
  sectionDescription: string
): LessonImageCandidate => ({
  caption: image.caption,
  id: image.id,
  intrinsicHeight: image.intrinsicHeight,
  intrinsicWidth: image.intrinsicWidth,
  pageNumber: image.pageNumber,
  sizeBytes: image.sizeBytes,
  sourceOrder: image.sourceOrder,
  textAfter: image.textAfter || undefined,
  textBefore: image.textBefore || undefined,
  textCurrent: image.textCurrent || undefined,
  visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
});

export const resolveLessonImageRefs = (input: {
  contentMarkdown: string;
  draftRefs: Array<{ alt: string; anchorHeading: string; assetId: string; caption: string }>;
  images: LessonPdfImageAsset[];
  sectionDescription: string;
  sectionTitle: string;
}): LessonImageReference[] => resolvePdfImageRefs(input);
