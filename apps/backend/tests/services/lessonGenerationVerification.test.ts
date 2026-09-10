import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { reviewLessonContentDraftStrict } from '../../src/services/lessonGenerationModel.js';
import type {
  LessonContentDraft,
  LessonGenerationInput,
} from '../../src/services/lessonGenerationTypes.js';

const { runCodexAppServerTurn } = vi.hoisted(() => ({ runCodexAppServerTurn: vi.fn() }));
vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));

const generationInput: LessonGenerationInput = {
  config: { ...getGlobalModelConfig(), aiProvider: 'codex', aiProviderOverrides: {} },
  description: 'Justify which candidates an ordered array lets us exclude.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext: '',
  previousLessonTitles: [],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Ordinamento ed esclusione',
  signal: new AbortController().signal,
  sourceContext: '',
  sources: [],
};

const original: LessonContentDraft = {
  contentBlocks: [
    {
      type: 'markdown',
      markdown:
        '## Ordinamento\n\nSe il bersaglio supera il centro, tutti i valori a sinistra sono troppo piccoli. Si escludono il centro e la parte sinistra.',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};

// Saved model output from the failed minimal-depth review.
const unrelatedReview: LessonContentDraft = {
  contentBlocks: [
    { markdown: '## Rapporto di verifica\n\n', type: 'markdown' },
    {
      quiz: {
        correctIndex: 0,
        explanation: 'La verifica è stata completata sul testo fornito.',
        exerciseType: 'concept-check',
        options: [
          'Verifica completata',
          'Verifica non completata',
          'Verifica parziale',
          'Verifica rinviata',
        ],
        question: 'Qual è lo stato della verifica?',
      },
      type: 'inline-quiz',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};

const preserved = {
  topic: {
    preserved: true,
    evidence: 'The corrected lesson still explains ordered-array exclusion.',
  },
  objectives: {
    preserved: true,
    evidence: 'It still explains why the center and left candidates can be excluded.',
  },
};

const mockReview = (draft: LessonContentDraft, lessonIntegrity: unknown) => {
  runCodexAppServerTurn.mockImplementation(async ({ outputSchema }) => {
    const checkIds: string[] =
      outputSchema.properties.verificationReport.items.properties.checkId.enum;
    return JSON.stringify({
      ...draft,
      ...(lessonIntegrity === undefined ? {} : { lessonIntegrity }),
      verificationReport: checkIds.map(checkId => ({
        action: 'Retain the reviewed content.',
        checkId,
        evidence: 'Complete deterministic report fixture.',
        status: 'pass',
      })),
    });
  });
};

const review = () => reviewLessonContentDraftStrict({ draft: original, generationInput });

beforeEach(() => {
  runCodexAppServerTurn.mockReset();
});

describe('lesson review preserves its subject and learning objectives', () => {
  test('rejects the saved replacement when the semantic assessment reports the loss', async () => {
    mockReview(unrelatedReview, {
      topic: {
        preserved: false,
        evidence: 'The output describes the review status instead of binary search.',
      },
      objectives: {
        preserved: false,
        evidence: 'It no longer explains exclusion of ordered-array candidates.',
      },
    });
    await expect(review()).rejects.toMatchObject({ code: 'lesson_review_integrity_failed' });
    expect(runCodexAppServerTurn).toHaveBeenCalledOnce();
  });

  test.each([
    'topic',
    'objectives',
  ] as const)('rejects loss of %s independently', async dimension => {
    mockReview(original, {
      ...preserved,
      [dimension]: { preserved: false, evidence: 'Required content was removed.' },
    });
    await expect(review()).rejects.toMatchObject({ code: 'lesson_review_integrity_failed' });
  });

  test.each([
    undefined,
    {},
    { topic: preserved.topic },
    { ...preserved, topic: { preserved: 'true', evidence: 'Invalid declaration type.' } },
    { ...preserved, objectives: { preserved: true, evidence: '   ' } },
  ])('rejects an absent or invalid integrity assessment: %j', async integrity => {
    mockReview(original, integrity);
    await expect(review()).rejects.toMatchObject({ code: 'lesson_review_integrity_invalid' });
  });

  test('returns the corrected lesson and removes both internal reports', async () => {
    mockReview(original, preserved);
    await expect(review()).resolves.toEqual(original);
    expect(runCodexAppServerTurn).toHaveBeenCalledOnce();
    const schema = runCodexAppServerTurn.mock.calls[0][0].outputSchema;
    expect(schema.properties.lessonIntegrity).not.toHaveProperty('$schema');
    expect(schema.required).toEqual(
      expect.arrayContaining(['contentBlocks', 'verificationReport', 'lessonIntegrity'])
    );
    expect(schema.properties.lessonIntegrity).toMatchObject({
      additionalProperties: false,
      required: ['topic', 'objectives'],
      properties: {
        topic: {
          required: ['preserved', 'evidence'],
          properties: { preserved: { type: 'boolean' } },
        },
        objectives: {
          required: ['preserved', 'evidence'],
          properties: { preserved: { type: 'boolean' } },
        },
      },
    });
  });
});
