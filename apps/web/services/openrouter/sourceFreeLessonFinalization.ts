import type {
  LessonGeneratedVisual,
  LessonLearningAid,
  LessonVisualPlanningDecision,
  QuizQuestion,
} from '../../types.ts';
import type { GenerationStatusReporter } from './generationProgress.ts';
import { generateLessonLearningAids } from './learningAids.ts';
import { materializeGeneratedVisualSlots } from './lessonImages.ts';
import {
  estimateTargetQuizCount,
  generateStandaloneLessonQuiz,
  normalizeQuizLength,
  repairLessonMarkdown,
  sanitizeLessonMarkdownContent,
} from './lessonMarkdownQuality/index.ts';
import { type LessonVerificationDraft, verifyLessonDraft } from './lessonVerification.ts';
import { LESSON_SCOPE_RULES } from './prompts.ts';
import type { VerifiedVisualSlotPlan } from './visualExamples.ts';

export interface FinalizedSourceFreeLesson {
  content: string;
  generatedVisuals: LessonGeneratedVisual[];
  learningAids: LessonLearningAid[];
  quiz: QuizQuestion[];
  visualPlanningDecision: LessonVisualPlanningDecision;
}

export const finalizeSourceFreeLesson = async (args: {
  contentMarkdown: string;
  generationNotes?: string;
  language?: string;
  onReasoningUpdate?: (reasoning: string) => void;
  onStatusUpdate?: GenerationStatusReporter;
  previousContext?: string;
  sectionDescription: string;
  sectionTitle: string;
  sourceContext?: string;
  visualPlanning?: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
}): Promise<FinalizedSourceFreeLesson> => {
  const previousContext = args.previousContext?.trim() || '';
  const continuityRule = previousContext
    ? 'Usa soltanto il contesto precedente fornito; non inventare contenuti già trattati.'
    : 'Questa è la prima lezione disponibile: non inventare riferimenti retroattivi.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  const repairedContent = await repairLessonMarkdown(
    args.contentMarkdown,
    args.sectionTitle,
    args.sourceContext || args.sectionDescription,
    args.sectionDescription,
    args.generationNotes,
    args.onReasoningUpdate
  ).catch(error => {
    console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
    return args.contentMarkdown;
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
      contentMarkdown: repairedContent.trim(),
      quiz: [],
      imagePlacements: [],
      visualPlanning: args.visualPlanning ?? {
        plans: [],
        rationale: 'La bozza non conteneva una pianificazione visuale strutturata.',
      },
    },
    candidateImages: [],
    generationNotes: args.generationNotes,
    onReasoningUpdate: args.onReasoningUpdate,
  }).catch(async error => {
    console.warn('[Nous][Lesson] Final verification failed, keeping repaired draft.', error);
    let fallbackQuiz: QuizQuestion[] = [];
    try {
      fallbackQuiz = await generateStandaloneLessonQuiz({
        contentMarkdown: repairedContent,
        sectionTitle: args.sectionTitle,
        language: args.language,
      });
    } catch (quizError) {
      console.warn('[Nous][Lesson] Fallback quiz generation failed.', quizError);
    }
    return {
      contentMarkdown: repairedContent.trim(),
      quiz: normalizeQuizLength(fallbackQuiz, targetQuizCount),
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

  return {
    content: visualResult.content,
    generatedVisuals: visualResult.generatedVisuals,
    learningAids,
    quiz: normalizeQuizLength(verifiedDraft.quiz, targetQuizCount),
    visualPlanningDecision: visualResult.visualPlanningDecision,
  };
};
