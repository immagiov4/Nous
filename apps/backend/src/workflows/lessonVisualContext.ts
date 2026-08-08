import { createHash } from 'node:crypto';

export interface LessonVisualContext {
  readonly lessonMarkdown: string;
  readonly sectionDescription: string;
  readonly sectionTitle: string;
}

export const buildLessonVisualContextFingerprint = (context: LessonVisualContext): string =>
  createHash('sha256')
    .update(
      JSON.stringify([context.lessonMarkdown, context.sectionDescription, context.sectionTitle])
    )
    .digest('hex');
