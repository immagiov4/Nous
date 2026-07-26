import type {
  LessonContentBlock,
  LessonGeneratedVisual,
  LessonLearningAid,
  LessonVisualPlanningDecision,
  QuizQuestion,
} from '../../types.ts';
import type { LessonInstructionPackId } from '../../utils/learning/lessonInstructionPacks.ts';
import {
  deriveQuizFromLessonContentBlocks,
  hasValidTypedQuizBlocks,
  legacyMarkdownToLessonContentBlocks,
  lessonContentBlocksToLegacyMarkdown,
  materializeGeneratedVisualBlocks,
} from '../../utils/reader/lessonContentBlocks.ts';
import type { GenerationStatusReporter } from './generationProgress.ts';
import { generateLessonLearningAids } from './learningAids.ts';
import { materializeGeneratedVisualSlots } from './lessonImages.ts';
import {
  estimateTargetQuizCount,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
  repairLessonMarkdown,
  sanitizeLessonMarkdownContent,
} from './lessonMarkdownQuality/index.ts';
import { type LessonVerificationDraft, verifyLessonDraft } from './lessonVerification.ts';
import { LESSON_SCOPE_RULES } from './prompts.ts';
import type { VerifiedVisualSlotPlan } from './visualExamples.ts';

export interface FinalizedSourceFreeLesson {
  content: string;
  contentBlocks: LessonContentBlock[];
  generatedVisuals: LessonGeneratedVisual[];
  learningAids: LessonLearningAid[];
  quiz: QuizQuestion[];
  visualPlanningDecision: LessonVisualPlanningDecision;
}

export const finalizeSourceFreeLesson = async (args: {
  contentMarkdown: string;
  contentBlocks?: LessonContentBlock[];
  generationNotes?: string;
  instructionPacks?: LessonInstructionPackId[];
  onReasoningUpdate?: (reasoning: string) => void;
  onStatusUpdate?: GenerationStatusReporter;
  previousContext?: string;
  quiz?: QuizQuestion[];
  sectionDescription: string;
  sectionTitle: string;
  sourceContext?: string;
  visualPlanning?: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
}): Promise<FinalizedSourceFreeLesson> => {
  const originalBlocks =
    args.contentBlocks ??
    legacyMarkdownToLessonContentBlocks(args.contentMarkdown, args.quiz ?? []);
  const originalContent = lessonContentBlocksToLegacyMarkdown(originalBlocks);
  const originalQuiz = args.contentBlocks
    ? deriveQuizFromLessonContentBlocks(originalBlocks)
    : (args.quiz ?? []);
  if (
    !hasValidTypedQuizBlocks(originalBlocks, {
      max: MAX_LESSON_QUIZ_QUESTIONS,
      min: MIN_LESSON_QUIZ_QUESTIONS,
    })
  ) {
    throw new Error('Cannot finalize a lesson with an invalid typed inline quiz contract.');
  }

  const previousContext = args.previousContext?.trim() || '';
  const continuityRule = previousContext
    ? 'Usa soltanto il contesto precedente fornito; non inventare contenuti già trattati.'
    : 'Questa è la prima lezione disponibile: non inventare riferimenti retroattivi.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  const repairedContent = args.contentBlocks
    ? originalContent
    : await repairLessonMarkdown(
        args.contentMarkdown,
        args.sectionTitle,
        args.sourceContext || args.sectionDescription,
        args.sectionDescription,
        args.generationNotes,
        args.onReasoningUpdate
      ).catch(error => {
        console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
        return originalContent;
      });

  const targetQuizCount = estimateTargetQuizCount(repairedContent);
  args.onStatusUpdate?.('Verifica finale...', 'verification');
  const verifiedDraft = await verifyLessonDraft({
    sectionTitle: args.sectionTitle,
    sectionDescription: args.sectionDescription,
    previousContext,
    sourceContext: args.sourceContext || args.sectionDescription,
    continuityRule,
    scopeRule,
    targetQuizCount,
    draft: {
      contentBlocks: originalBlocks,
      contentMarkdown: repairedContent.trim(),
      quiz: originalQuiz,
      imagePlacements: [],
      visualPlanning: args.visualPlanning ?? {
        plans: [],
        rationale: 'La bozza non conteneva una pianificazione visuale strutturata.',
      },
    },
    candidateImages: [],
    generationNotes: args.generationNotes,
    instructionPacks: args.instructionPacks,
    onReasoningUpdate: args.onReasoningUpdate,
  }).catch(error => {
    console.warn('[Nous][Lesson] Final verification failed, keeping original draft.', error);
    return {
      contentBlocks: originalBlocks,
      contentMarkdown: originalContent,
      quiz: originalQuiz,
      imagePlacements: [],
      visualPlanning: args.visualPlanning ?? {
        plans: [],
        rationale: 'La verifica visuale non è stata completata.',
      },
    } satisfies LessonVerificationDraft;
  });

  const cleanedContent = sanitizeLessonMarkdownContent(verifiedDraft.contentMarkdown);
  const [visualResult, learningAids] = await Promise.all([
    materializeGeneratedVisualSlots({
      contentMarkdown: cleanedContent,
      generationNotes: args.generationNotes,
      hasPdfImages: false,
      onStatusUpdate: status => args.onStatusUpdate?.(status),
      sectionDescription: args.sectionDescription,
      sectionTitle: args.sectionTitle,
      visualPlanning: verifiedDraft.visualPlanning,
    }),
    generateLessonLearningAids({
      contentMarkdown: cleanedContent,
      sectionDescription: args.sectionDescription,
      sectionTitle: args.sectionTitle,
    }),
  ]);

  const verifiedBlocks = verifiedDraft.contentBlocks ?? originalBlocks;
  if (
    !hasValidTypedQuizBlocks(verifiedBlocks, {
      max: targetQuizCount,
      min: MIN_LESSON_QUIZ_QUESTIONS,
    })
  ) {
    throw new Error('Finalized lesson has an invalid typed inline quiz contract.');
  }

  const finalizedBlocks = materializeGeneratedVisualBlocks(
    verifiedBlocks,
    verifiedDraft.visualPlanning.plans,
    visualResult.generatedVisualSlots
  );

  return {
    content: visualResult.content,
    contentBlocks: finalizedBlocks,
    generatedVisuals: visualResult.generatedVisuals,
    learningAids,
    quiz: verifiedDraft.quiz,
    visualPlanningDecision: visualResult.visualPlanningDecision,
  };
};
