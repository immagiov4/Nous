import type { LessonWorkflowResult } from '@shared/lessonWorkflowContract';
import { describe, expect, test } from 'vitest';

import {
  LessonAidsStateSchema,
  LessonContextStateSchema,
  LessonCoverageStateSchema,
  LessonDraftStateSchema,
  LessonGenerationPreparationOutcomeSchema,
  LessonGenerationRequestSchema,
  LessonGenerationWorkflowInputSchema,
  LessonGenerationWorkflowResultSchema,
  LessonPersistenceStateSchema,
  LessonResearchStateSchema,
  LessonReviewedStateSchema,
  LessonSourcesStateSchema,
  LessonVisualsStateSchema,
  LessonYouTubeStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import {
  LessonPdfImageMetadataSchema,
  LessonQuizSchema,
} from '../../src/workflows/lessonGenerationWorkflowSchemas.js';

const request = {
  forceRegenerate: true,
  projectId: 'project-1',
  sectionId: 'section-1',
  userId: 'user-1',
};

const contextState = {
  documentSourceHash: null,
  existingDossierJson: null,
  existingSources: [],
  lessonInputData: {
    description: 'Comunicazione a messaggi senza orologio globale.',
    imageCandidates: [],
    instructionPacks: [],
    language: 'Italiano',
    pedagogicalContext: '',
    previousLessonTitles: [],
    sectionTitle: 'Comunicazioni a messaggi',
    sourceContext: '',
  },
  originalSources: [],
  request,
  requiresCoverageAssessment: false,
  sourceFingerprint: 'a'.repeat(64),
  stage: 'context' as const,
  targetFingerprint: 'b'.repeat(64),
  warnings: [
    {
      code: 'lesson_pdf_image_extraction_incomplete' as const,
      pageNumber: 4,
      sourceId: 'source-1',
      stage: 'sources' as const,
    },
  ],
  youtubePlanning: {
    courseTitle: 'Fondamenti dei sistemi distribuiti',
    keyConcepts: ['happens-before'],
  },
};

const coverageState = { ...contextState, stage: 'coverage' as const };
const sourcesState = {
  ...coverageState,
  documentAssetOwners: [],
  pdfImages: [],
  stage: 'sources' as const,
};
const youtubeState = {
  ...sourcesState,
  discoveredYoutubeSources: [],
  research: { context: '', youtube: null },
  stage: 'youtube' as const,
};
const researchState = {
  ...youtubeState,
  lessonSources: [],
  research: { context: '', summary: null, youtube: null },
  stage: 'research' as const,
};
const draft = {
  contentBlocks: [
    { markdown: '## Causalità\nLa causalità induce un ordine parziale.', type: 'markdown' },
  ],
  generatedVisuals: [],
  imageRefs: [],
};
const draftState = { ...researchState, draft, stage: 'draft' as const };
const reviewedState = LessonReviewedStateSchema.parse({ ...draftState, stage: 'review' as const });
const aidsState = { ...reviewedState, learningAids: [], stage: 'aids' as const };
const visualPlanningDecision = {
  initial: { outcome: 'none', plans: [], rationale: '' },
  reviewed: { outcome: 'none', plans: [], rationale: '' },
  reviewedAt: '2026-07-29T18:00:00.000Z',
};
const visualsState = {
  ...aidsState,
  content: '## Causalità\nLa causalità induce un ordine parziale.',
  contentBlocks: draft.contentBlocks,
  documentAssets: null,
  generatedVisuals: [],
  imageRefs: [],
  quiz: [],
  stage: 'visuals' as const,
  visualAssetOwners: [],
  visualPlanningDecision,
};
const result = {
  content: visualsState.content,
  contentBlocks: visualsState.contentBlocks,
  generatedVisuals: [],
  imageRefs: [],
  learningAids: [],
  projectId: request.projectId,
  projectRevision: 7,
  quiz: [],
  researchDossier: {
    sectionId: request.sectionId,
    sources: [],
    title: contextState.lessonInputData.sectionTitle,
  },
  sectionId: request.sectionId,
  visualPlanningDecision,
  warnings: contextState.warnings,
};
const persistenceState = {
  committedTargetFingerprint: 'c'.repeat(64),
  persistedAt: '2026-07-29T18:00:00.000Z',
  previous: {
    documentAssetsJson: null,
    researchDossierJson: null,
    sectionJson: '{}',
  },
  result,
  stage: 'persistence' as const,
  userId: request.userId,
};

describe('lesson generation workflow contract', () => {
  test('accepts explicit existing and sublesson starts but compacts both to one lesson request', () => {
    const existing = {
      ...request,
      kind: 'existing' as const,
    };
    const sublesson = {
      ...request,
      forceRegenerate: false as const,
      focus: {
        annotationNote: 'Ricollega questo passaggio alla nota.',
        contextAfter: 'Testo successivo',
        contextBefore: 'Testo precedente',
        instructions: 'Approfondisci con un esempio.',
        selectedText: 'assenza di orologio globale',
      },
      kind: 'sublesson' as const,
      parentSectionId: 'parent-1',
    };

    expect(LessonGenerationWorkflowInputSchema.parse(existing)).toEqual(existing);
    expect(LessonGenerationWorkflowInputSchema.parse(sublesson)).toEqual(sublesson);
    expect(LessonGenerationRequestSchema.parse(sublesson)).toEqual({
      forceRegenerate: false,
      projectId: request.projectId,
      sectionId: request.sectionId,
      userId: request.userId,
    });
    expect(
      LessonGenerationWorkflowInputSchema.safeParse({ ...sublesson, forceRegenerate: true }).success
    ).toBe(false);
  });

  test('requires a logical id and project asset instead of durable PDF Base64', () => {
    const asset = {
      byteSize: 4_096,
      hash: 'd'.repeat(64),
      id: 'e'.repeat(64),
      mediaType: 'image/png',
    };
    const pdfImage = {
      asset,
      id: 'pdf-image-2',
      sourceOrder: 2,
      textAfter: '',
      textBefore: '',
    };

    expect(
      LessonPdfImageMetadataSchema.safeParse({
        ...pdfImage,
        asset: undefined,
        dataUrl: 'data:image/png;base64,AAAA',
      }).success
    ).toBe(false);
    expect(
      LessonPdfImageMetadataSchema.parse({
        ...pdfImage,
        dataUrl: 'data:image/png;base64,AAAA',
      })
    ).toEqual(pdfImage);
  });

  test('round-trips every resumable stage and both preparation outcomes', () => {
    const stages = [
      [LessonContextStateSchema, contextState],
      [LessonCoverageStateSchema, coverageState],
      [LessonSourcesStateSchema, sourcesState],
      [LessonYouTubeStateSchema, youtubeState],
      [LessonResearchStateSchema, researchState],
      [LessonDraftStateSchema, draftState],
      [LessonReviewedStateSchema, reviewedState],
      [LessonAidsStateSchema, aidsState],
      [LessonVisualsStateSchema, visualsState],
      [LessonPersistenceStateSchema, persistenceState],
    ] as const;

    for (const [schema, state] of stages) expect(schema.parse(state)).toEqual(state);
    expect(
      LessonGenerationPreparationOutcomeSchema.parse({ kind: 'generate', state: contextState })
    ).toEqual({ kind: 'generate', state: contextState });
    expect(
      LessonGenerationPreparationOutcomeSchema.parse({ kind: 'already-completed', result })
    ).toEqual({ kind: 'already-completed', result });

    const durable: LessonWorkflowResult = LessonGenerationWorkflowResultSchema.parse(result);
    expect(durable).toEqual(result);
  });

  test('compacts generation-only context before persisting the reviewed checkpoint', () => {
    expect(reviewedState).not.toHaveProperty('originalSources');
    expect(reviewedState).not.toHaveProperty('youtubePlanning');
    expect(reviewedState.lessonInputData).not.toHaveProperty('instructionPacks');
    expect(reviewedState.research).not.toHaveProperty('context');
  });

  test('rejects malformed structured lesson output before checkpointing it', () => {
    expect(
      LessonDraftStateSchema.safeParse({
        ...draftState,
        draft: { ...draft, contentBlocks: [{ type: 'markdown' }] },
      }).success
    ).toBe(false);
    expect(
      LessonQuizSchema.safeParse({
        correctIndex: 4,
        exerciseType: 'recall',
        options: ['A', 'B', 'C', 'D'],
        question: 'Domanda',
      }).success
    ).toBe(false);
  });
});
