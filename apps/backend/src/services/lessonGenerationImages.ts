import {
  type PdfImageContext,
  type PdfImageReference,
  resolvePdfImageRefs,
  resolvePdfImageRefsWithSource,
} from '@shared/lessonPdfImageSelection';

export {
  buildVisibleImageLabel,
  selectCandidatePdfImages,
} from '@shared/lessonPdfImageSelection';

export type LessonImageReference = PdfImageReference;

export const resolveLessonImageRefs = <T extends PdfImageContext>(input: {
  contentMarkdown: string;
  draftRefs: Array<{ alt: string; anchorHeading: string; assetId: string; caption: string }>;
  images: T[];
  sectionDescription: string;
  sectionTitle: string;
}): LessonImageReference[] => resolvePdfImageRefs(input);

export const resolveLessonImageRefsWithSource = <T extends PdfImageContext>(input: {
  contentMarkdown: string;
  draftRefs: Array<{ alt: string; anchorHeading: string; assetId: string; caption: string }>;
  images: T[];
  sectionDescription: string;
  sectionTitle: string;
}) => resolvePdfImageRefsWithSource(input);
