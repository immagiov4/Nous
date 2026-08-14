import {
  enforceLessonVisualTypeContract,
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_LESSON_QUIZ_QUESTIONS,
} from '@shared/lessonGenerationPolicy';
import type { PdfImageContext } from '@shared/lessonPdfImageSelection';
import { unwrapWholeQuizCodeFormatting } from '@shared/lessonQuizFormatting';
import { isYouTubeClipWithinTranscriptBounds } from '@shared/youtubeTranscript';

import { buildVisibleImageLabel, resolveLessonImageRefs } from './lessonGenerationImages.js';
import type { ResearchSource } from './lessonGenerationSources.js';
import type {
  LessonGenerationDraft,
  LessonGenerationDraftBlock,
  NormalizedLessonBlock,
} from './lessonGenerationTypes.js';
import { type LessonVisualDraftPlan, toVisualRetryPlan } from './lessonGenerationVisuals.js';

export const toLessonContent = (blocks: readonly { markdown?: string; type: string }[]): string =>
  blocks
    .flatMap(block =>
      block.type === 'markdown' && block.markdown?.trim() ? [block.markdown.trim()] : []
    )
    .join('\n\n');

const isClipWithinTranscript = (
  source: ResearchSource | undefined,
  startSeconds: number,
  endSeconds: number
): boolean =>
  Boolean(
    source?.youtubeTranscript &&
      isYouTubeClipWithinTranscriptBounds(
        { endSeconds, startSeconds },
        source.youtubeTranscript.segments
      )
  );

const sanitizeMarkdownBlock = (
  markdown: string,
  visibleLabelByAssetId: ReadonlyMap<string, string>
): string => {
  let sanitized = markdown;
  for (const [assetId, visibleLabel] of visibleLabelByAssetId) {
    sanitized = sanitized.replaceAll(assetId, `"${visibleLabel}"`);
  }
  const withoutEmbeddedImages = sanitized
    .replaceAll(/!\[[^\n]*?\]\([^)\n]*\)/gu, '')
    .replaceAll(/<img\b[^>]*>/giu, '');
  const compactLines: string[] = [];
  for (const line of withoutEmbeddedImages.split('\n')) {
    const trimmedLine = line.trimEnd();
    if (trimmedLine || compactLines.at(-1) !== '') compactLines.push(trimmedLine);
  }
  return compactLines.join('\n').trim();
};

const sanitizeQuiz = (
  quiz: Extract<LessonGenerationDraftBlock, { type: 'inline-quiz' }>['quiz']
) => ({
  ...quiz,
  question: unwrapWholeQuizCodeFormatting(quiz.question),
  options: quiz.options.map(unwrapWholeQuizCodeFormatting),
});

const normalizeYouTubeBlock = (
  block: Extract<LessonGenerationDraftBlock, { type: 'youtube-clips' }>,
  sources: ResearchSource[]
): Extract<LessonGenerationDraftBlock, { type: 'youtube-clips' }> | null => {
  const clips = block.clips.filter(clip =>
    isClipWithinTranscript(sources[clip.sourceIndex], clip.startSeconds, clip.endSeconds)
  );
  return clips.length > 0 ? { ...block, clips } : null;
};

interface StoredVisualReference {
  readonly id: string;
}

const normalizeGeneratedVisualBlock = <Visual extends StoredVisualReference>(
  block: Extract<LessonGenerationDraftBlock, { type: 'generated-visual' }>,
  plansBySlotId: ReadonlyMap<string, LessonVisualDraftPlan>,
  visualsBySlotId: ReadonlyMap<string, Visual>
): NormalizedLessonBlock | null => {
  const plan = plansBySlotId.get(block.slotId);
  if (!plan) return null;
  const visual = visualsBySlotId.get(block.slotId);
  if (visual) return { ...block, visualId: visual.id };
  return { ...block, retryPlan: toVisualRetryPlan(plan) };
};

export const collectLessonVisualPlans = (
  draft: Pick<LessonGenerationDraft, 'contentBlocks' | 'generatedVisuals'>
): Map<string, LessonVisualDraftPlan> => {
  const plansBySlotId = new Map<string, LessonVisualDraftPlan>();
  const blockCounts = new Map<string, number>();
  for (const block of draft.contentBlocks) {
    if (block.type === 'generated-visual') {
      blockCounts.set(block.slotId, (blockCounts.get(block.slotId) || 0) + 1);
    }
  }
  for (const plan of draft.generatedVisuals.slice(0, MAX_GENERATED_VISUALS_PER_LESSON)) {
    const normalizedPlan = enforceLessonVisualTypeContract(plan);
    if (
      normalizedPlan.slotId.trim() &&
      blockCounts.get(normalizedPlan.slotId) === 1 &&
      !plansBySlotId.has(normalizedPlan.slotId)
    ) {
      plansBySlotId.set(normalizedPlan.slotId, normalizedPlan);
    }
  }
  return plansBySlotId;
};

const appendGeneratedVisualBlock = <Visual extends StoredVisualReference>({
  block,
  contentBlocks,
  plansBySlotId,
  visualCount,
  visualsBySlotId,
}: {
  block: Extract<LessonGenerationDraft['contentBlocks'][number], { type: 'generated-visual' }>;
  contentBlocks: NormalizedLessonBlock[];
  plansBySlotId: Map<string, LessonVisualDraftPlan>;
  visualCount: number;
  visualsBySlotId: ReadonlyMap<string, Visual>;
}): number => {
  if (visualCount >= MAX_GENERATED_VISUALS_PER_LESSON) return visualCount;
  const normalizedBlock = normalizeGeneratedVisualBlock(block, plansBySlotId, visualsBySlotId);
  if (!normalizedBlock) return visualCount;
  contentBlocks.push(normalizedBlock);
  return visualCount + 1;
};

const normalizeContentBlocks = <Visual extends StoredVisualReference>({
  draft,
  plansBySlotId,
  sources,
  visibleLabelByAssetId,
  visualsBySlotId,
}: {
  draft: Pick<LessonGenerationDraft, 'contentBlocks' | 'generatedVisuals' | 'imageRefs'>;
  plansBySlotId: Map<string, LessonVisualDraftPlan>;
  sources: ResearchSource[];
  visibleLabelByAssetId: ReadonlyMap<string, string>;
  visualsBySlotId: ReadonlyMap<string, Visual>;
}): NormalizedLessonBlock[] => {
  const contentBlocks: NormalizedLessonBlock[] = [];
  let hasExplanatoryMarkdown = false;
  let quizCount = 0;
  let visualCount = 0;
  for (const block of draft.contentBlocks) {
    switch (block.type) {
      case 'inline-quiz':
        if (quizCount >= MAX_LESSON_QUIZ_QUESTIONS || !hasExplanatoryMarkdown) break;
        quizCount += 1;
        contentBlocks.push({ ...block, quiz: sanitizeQuiz(block.quiz) });
        hasExplanatoryMarkdown = false;
        break;
      case 'youtube-clips': {
        const normalizedBlock = normalizeYouTubeBlock(block, sources);
        if (normalizedBlock) contentBlocks.push(normalizedBlock);
        break;
      }
      case 'markdown': {
        const markdown = sanitizeMarkdownBlock(block.markdown, visibleLabelByAssetId);
        if (markdown) contentBlocks.push({ ...block, markdown });
        hasExplanatoryMarkdown = Boolean(markdown);
        break;
      }
      case 'generated-visual': {
        visualCount = appendGeneratedVisualBlock({
          block,
          contentBlocks,
          plansBySlotId,
          visualCount,
          visualsBySlotId,
        });
        break;
      }
    }
  }
  return contentBlocks;
};

export const normalizeLessonStructure = <
  Image extends PdfImageContext,
  Visual extends StoredVisualReference,
>(input: {
  availableImages: Image[];
  draft: Pick<LessonGenerationDraft, 'contentBlocks' | 'generatedVisuals' | 'imageRefs'>;
  generatedAt: string;
  sectionDescription: string;
  sectionTitle: string;
  sources: ResearchSource[];
  visualsBySlotId: ReadonlyMap<string, Visual>;
}) => {
  const plansBySlotId = collectLessonVisualPlans(input.draft);
  const visibleLabelByAssetId = new Map(
    input.availableImages.map(image => [
      image.id,
      buildVisibleImageLabel(image, input.sectionTitle, input.sectionDescription),
    ])
  );
  const contentBlocks = normalizeContentBlocks({
    draft: input.draft,
    plansBySlotId,
    sources: input.sources,
    visibleLabelByAssetId,
    visualsBySlotId: input.visualsBySlotId,
  });
  const referencedVisualSlots = new Set(
    contentBlocks.flatMap(block => (block.type === 'generated-visual' ? [block.slotId] : []))
  );
  const generatedVisuals = [...input.visualsBySlotId.entries()].flatMap(([slotId, visual]) =>
    referencedVisualSlots.has(slotId) ? [visual] : []
  );
  const content = toLessonContent(contentBlocks);
  if (!content) throw new Error('Generated lesson content is empty.');
  const visualPlans = [...plansBySlotId.values()].map(plan => ({
    anchorHeading: plan.anchorHeading.trim() || null,
    concept: plan.concept.trim(),
    pedagogicalGoal: plan.pedagogicalGoal.trim(),
    reason: plan.reason.trim(),
    visualType: plan.visualType,
  }));
  const visualPlanningPass = {
    outcome: visualPlans.length ? ('visuals' as const) : ('none' as const),
    plans: visualPlans,
    rationale: visualPlans.length
      ? `${generatedVisuals.length} di ${visualPlans.length} visuali pianificati sono stati generati; gli altri restano ritentabili nella lezione.`
      : 'Nessun visuale è stato pianificato per questa lezione.',
  };
  const imageRefs = resolveLessonImageRefs({
    contentMarkdown: content,
    draftRefs: input.draft.imageRefs,
    images: input.availableImages,
    sectionDescription: input.sectionDescription,
    sectionTitle: input.sectionTitle,
  });
  return {
    content,
    contentBlocks,
    generatedVisuals,
    imageRefs,
    quiz: contentBlocks.flatMap(block => (block.type === 'inline-quiz' ? [block.quiz] : [])),
    visualPlanningDecision: {
      initial: visualPlanningPass,
      reviewed: visualPlanningPass,
      reviewedAt: input.generatedAt,
    },
  };
};
