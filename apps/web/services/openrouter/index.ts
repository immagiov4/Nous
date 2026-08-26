export {
  buildAssessmentDocumentContextFromSourceSet,
  buildAssessmentDocumentContextFromTextSource,
  buildAssessmentDocumentPrompt,
} from './assessment.ts';
export { askContextualQuestion } from './contextChat.ts';
export {
  generateDurableCourse,
  repairDurablePdfMapping,
  resumeActiveDurableCourse,
} from './courseGenerationClient.ts';
export {
  cancelCourseInterview,
  getActiveCourseInterview,
  sendCourseInterviewAnswer,
  sendCourseInterviewDecision,
  startCourseInterview,
} from './courseInterviewClient.ts';
export { buildPdfTextIndex } from './documentIndex/index.ts';
export {
  generateApplicationExerciseBrief,
  getExercisePrerequisiteGaps,
} from './exercises/brief.ts';
export { generateApplicationExerciseFeedback } from './exercises/evaluation.ts';
export { generateApplicationExercisePlacements } from './exercises/placement.ts';
export type {
  GenerationProgressSnapshot,
  GenerationStatusReporter,
} from './generationProgress.ts';
export { createGenerationProgressObserver } from './generationProgress.ts';
export type { DurableLessonRecovery } from './lessonGenerationClient.ts';
export {
  clearDurableLessonRequestsForProject,
  generateDurableLesson,
  generateDurableSublesson,
  hasDurableLessonRequest,
  hasDurableSublessonRequest,
  isDurableSublessonRequestForSection,
  LessonGenerationBusyError,
  resolveDurableSublessonRequestForParent,
  resolveDurableSublessonRequestForSection,
} from './lessonGenerationClient.ts';
export { getPdfTextSession, validatePdfTextSource } from './pdfAssets.ts';
export {
  MODEL_ASSESSMENT,
  MODEL_CONTEXT,
  MODEL_FLASH,
  MODEL_REASONING,
  MODEL_RESEARCH_DOSSIER,
  MODEL_RESEARCH_PLANNER,
} from './shared.ts';
export { checkTTSStatus, generateSpeech, getTTSModels, getTTSVoices } from './tts.ts';
