import type { LessonInstructionPackId } from '@shared/lessonInstructionPacks';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { StoredLessonLearningAid } from './lessonGenerationAids.js';
import type { LessonImageCandidate, ResearchSource } from './lessonGenerationSources.js';
import type { LessonVisualDraftPlan, LessonVisualRetryPlan } from './lessonGenerationVisuals.js';

export interface LessonResearchSummary {
  avoidOversimplifying: string[];
  controversies: string[];
  difficultSteps: string[];
  factualSummary: string;
  keyExamples: string[];
  recentDevelopments: string[];
  sources: Array<{ note: string; title: string; url: string }>;
  youtubeCandidateDecisions?: Array<{
    decision: 'rejected' | 'selected-source';
    reason: string;
    url: string;
  }>;
}

export type LessonGenerationDraftBlock =
  | { markdown: string; type: 'markdown' }
  | {
      quiz: {
        correctIndex: number;
        exerciseType: string;
        options: string[];
        question: string;
      };
      type: 'inline-quiz';
    }
  | {
      clips: Array<{
        endSeconds: number;
        sourceIndex: number;
        startSeconds: number;
        title: string;
      }>;
      type: 'youtube-clips';
    }
  | { slotId: string; type: 'generated-visual' };

export type NormalizedLessonBlock =
  | Exclude<LessonGenerationDraftBlock, { type: 'generated-visual' }>
  | {
      retryPlan: LessonVisualRetryPlan;
      slotId: string;
      type: 'generated-visual';
    }
  | { slotId: string; type: 'generated-visual'; visualId: string };

export interface LessonGenerationDraft {
  contentBlocks: LessonGenerationDraftBlock[];
  generatedVisuals: LessonVisualDraftPlan[];
  imageRefs: Array<{
    alt: string;
    anchorHeading: string;
    assetId: string;
    caption: string;
  }>;
  learningAids: StoredLessonLearningAid[];
}

export type LessonContentDraft = Omit<LessonGenerationDraft, 'learningAids'>;

export interface LessonGenerationInput {
  config: GlobalModelConfig;
  coverageGaps?: string[];
  description: string;
  generationNotes?: string;
  imageCandidates: LessonImageCandidate[];
  instructionPacks: LessonInstructionPackId[];
  language: string;
  pedagogicalContext: string;
  previousLessonTitles: string[];
  refreshResearch: boolean;
  researchContext: string;
  retryFeedback?: string;
  sectionTitle: string;
  signal: AbortSignal;
  sourceContext: string;
  sources: ResearchSource[];
}

export type GenerateLessonContent = (input: LessonGenerationInput) => Promise<LessonContentDraft>;
export type GenerateResearch = (input: LessonGenerationInput) => Promise<LessonResearchSummary>;
