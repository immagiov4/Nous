export {
  createAssessmentChat,
  createAssessmentChatFromSourceSet,
  createAssessmentChatFromTextSource,
  createEmbeddedAssessmentChat,
  createEmbeddedAssessmentChatFromSourceSet,
  createEmbeddedAssessmentChatFromTextSource,
  createEmbeddedLearnAssessmentChat,
  createLearnAssessmentChat,
} from './assessment.ts';
export {
  buildLessonChunkContext,
  buildPdfTextIndex,
  getPdfLessonMappingState,
  needsPdfLessonMappingMigration,
  preparePdfLessonMappings,
  prepareSourceSetLessonMappings,
} from './documentIndex/index.ts';
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
export { generateLessonLearningAids } from './learningAids.ts';
export { getPdfTextSession, validatePdfTextSource } from './pdfAssets.ts';
export {
  askContextualQuestion,
  createArchiveSubChapterMetadata,
  createLearnSubChapterMetadata,
  createSubChapterMetadata,
  generateLearningPlan,
  generateLearningPlanFromSourceArchive,
  generateLearningPlanFromSourceSet,
  generateSectionContent,
  planLessonInstructionPacks,
} from './planning/index.ts';
export {
  buildPrerequisiteSourceContext,
  mergePrerequisiteDossierSources,
  selectPrerequisiteSourceCoverage,
} from './prerequisiteSources.ts';
export {
  buildLearningPlanFromResearchCourse,
  formatResearchDossierForPrompt,
  generateResearchCoursePlan,
  generateResearchLessonContent,
  generateResearchLessonDossier,
} from './research.ts';
export {
  MODEL_ASSESSMENT,
  MODEL_CONTEXT,
  MODEL_FLASH,
  MODEL_REASONING,
  MODEL_RESEARCH_DOSSIER,
  MODEL_RESEARCH_PLANNER,
} from './shared.ts';
export { finalizeSourceFreeLesson } from './sourceFreeLessonFinalization.ts';
export { checkTTSStatus, generateSpeech, getTTSModels, getTTSVoices } from './tts.ts';
export { generateLessonVisualExample } from './visualExamples.ts';
