import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { reviewLessonContentDraftStrict } from '../../src/services/lessonGenerationModel.js';
import type {
  LessonContentDraft,
  LessonGenerationInput,
} from '../../src/services/lessonGenerationTypes.js';
import { automationCourse, flawedAutomationLesson } from '../fixtures/lessonReviewQuality.js';

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

const mockReview = (
  draft: LessonContentDraft,
  lessonIntegrity: unknown,
  reportOverride?: Record<string, unknown>
) => {
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
        ...(checkId === reportOverride?.checkId ? reportOverride : {}),
      })),
    });
  });
};

const review = () => reviewLessonContentDraftStrict({ draft: original, generationInput });

beforeEach(() => {
  runCodexAppServerTurn.mockReset();
});

test('rejects Mermaid fences before model review', async () => {
  const draft = structuredClone(original);
  const markdown = draft.contentBlocks[0];
  if (markdown.type !== 'markdown') throw new Error('Expected markdown fixture.');
  markdown.markdown += '\n\n```mermaid\ngraph TD\nA-->B\n```';
  await expect(reviewLessonContentDraftStrict({ draft, generationInput })).rejects.toMatchObject({
    code: 'lesson_embedded_mermaid_unsupported',
  });
  expect(runCodexAppServerTurn).not.toHaveBeenCalled();
});

test('rejects Mermaid fences introduced by model review', async () => {
  const reviewed = structuredClone(original);
  const markdown = reviewed.contentBlocks[0];
  if (markdown.type !== 'markdown') throw new Error('Expected markdown fixture.');
  markdown.markdown += '\n\n```mermaid\ngraph TD\nA-->B\n```';
  mockReview(reviewed, preserved);

  await expect(review()).rejects.toMatchObject({
    code: 'lesson_embedded_mermaid_unsupported',
  });
  expect(runCodexAppServerTurn).toHaveBeenCalledOnce();
});

describe('lesson review quality report contract', () => {
  test('rejects a reviewer-introduced quiz fragment declared unresolved', async () => {
    const cleanDraft = structuredClone(flawedAutomationLesson);
    const quiz = cleanDraft.contentBlocks[1];
    if (quiz.type !== 'inline-quiz') throw new Error('Expected the fixture quiz.');
    quiz.quiz.question = 'Quale autorizzazione serve per inviare i promemoria?';
    const contaminated = structuredClone(cleanDraft);
    const changedQuiz = contaminated.contentBlocks[1];
    if (changedQuiz.type !== 'inline-quiz') throw new Error('Expected the fixture quiz.');
    changedQuiz.quiz.question += ' Any';
    mockReview(contaminated, preserved, {
      action: 'Remove the unrelated type fragment added to the question.',
      checkId: 'core.integrity',
      evidence: 'The revised question has an unrelated Any suffix absent from the draft.',
      status: 'failed',
    });
    await expect(
      reviewLessonContentDraftStrict({ draft: cleanDraft, generationInput })
    ).rejects.toMatchObject({ code: 'lesson_review_checks_failed' });
  });
  test.each([
    ['core.progression', 'The lights-off option precedes its teaching passage.'],
    ['positive-definition', 'The opening defines delegation by contrast.'],
    ['core.clarity', 'Ordinary Italian roles and actions still use avoidable English.'],
  ])('rejects an unresolved %s finding before returning learner content', async (checkId, evidence) => {
    mockReview(flawedAutomationLesson, preserved, {
      action: 'Repair the identified passage.',
      checkId,
      evidence,
      status: 'failed',
    });
    await expect(
      reviewLessonContentDraftStrict({
        draft: flawedAutomationLesson,
        generationInput: { ...generationInput, ...automationCourse },
      })
    ).rejects.toMatchObject({ code: 'lesson_review_checks_failed', feedback: expect.any(String) });
  });

  test.each([
    { status: 'unknown' },
    { status: 'corrected', action: '   ' },
    { status: 'pass', evidence: null },
    { status: 'not-applicable' },
  ])('rejects an invalid report entry %j', async entry => {
    mockReview(original, preserved, { checkId: 'core.integrity', ...entry });
    await expect(review()).rejects.toMatchObject({ code: 'lesson_review_report_incomplete' });
  });

  test('allows an absent optional feature to be assessed as not applicable', async () => {
    mockReview(original, preserved, {
      action: '',
      checkId: 'generated-visual',
      evidence: 'The task and lesson require no generated representation.',
      status: 'not-applicable',
    });
    await expect(review()).resolves.toEqual(original);
  });

  const featureDrafts: [string, LessonContentDraft][] = [
    ['quiz-quality', flawedAutomationLesson],
    [
      'image-reference',
      {
        ...original,
        imageRefs: [{ assetId: 'diagram', alt: 'Diagramma', caption: 'Relazioni ordinate.' }],
      },
    ],
    [
      'youtube-structure',
      {
        ...original,
        contentBlocks: [
          ...original.contentBlocks,
          {
            type: 'youtube-clips',
            clips: [
              {
                sourceIndex: 0,
                startSeconds: 0,
                endSeconds: 10,
                title: 'Esclusione dei candidati',
              },
            ],
          },
        ],
      },
    ],
    [
      'generated-visual',
      {
        ...original,
        contentBlocks: [
          ...original.contentBlocks,
          { type: 'generated-visual', slotId: 'comparison' },
        ],
      },
    ],
  ];

  test.each(
    featureDrafts
  )('requires a judgment for existing %s content', async (checkId, draft) => {
    mockReview(draft, preserved, { checkId, status: 'not-applicable' });
    await expect(reviewLessonContentDraftStrict({ draft, generationInput })).rejects.toMatchObject({
      code: 'lesson_review_report_incomplete',
    });
  });

  test('requires a judgment for a removed quiz and for a quiz introduced by review', async () => {
    for (const [draft, reviewed] of [
      [flawedAutomationLesson, original],
      [original, flawedAutomationLesson],
    ]) {
      mockReview(reviewed, preserved, { checkId: 'quiz-quality', status: 'not-applicable' });
      await expect(
        reviewLessonContentDraftStrict({ draft, generationInput })
      ).rejects.toMatchObject({ code: 'lesson_review_report_incomplete' });
    }
  });

  test.each([
    ['math-structure', 'Il servizio costa $10.'],
    ['code-structure', 'La parola `ordinamento` descrive la disposizione dei valori.'],
  ])('allows semantic non-applicability for a %s syntax candidate', async (checkId, markdown) => {
    const draft: LessonContentDraft = {
      ...original,
      contentBlocks: [{ type: 'markdown', markdown }],
    };
    mockReview(draft, preserved, { checkId, status: 'not-applicable' });
    await expect(reviewLessonContentDraftStrict({ draft, generationInput })).resolves.toEqual(
      draft
    );
  });

  test('allows source images to satisfy the visual pack without generated visuals', async () => {
    const draft = {
      ...original,
      imageRefs: [{ assetId: 'diagram', alt: 'Diagramma', caption: 'Relazioni ordinate.' }],
    };
    mockReview(draft, preserved, { checkId: 'generated-visual', status: 'not-applicable' });
    await expect(
      reviewLessonContentDraftStrict({
        draft,
        generationInput: { ...generationInput, instructionPacks: ['visual-learning'] },
      })
    ).resolves.toEqual(draft);
  });

  test.each([
    false,
    true,
  ])('requires visual judgment when source images were removed: %s', async hadImage => {
    const draft = {
      ...original,
      imageRefs: hadImage
        ? [{ assetId: 'diagram', alt: 'Diagramma', caption: 'Relazioni ordinate.' }]
        : [],
    };
    mockReview(original, preserved, { checkId: 'generated-visual', status: 'not-applicable' });
    await expect(
      reviewLessonContentDraftStrict({
        draft,
        generationInput: { ...generationInput, instructionPacks: ['visual-learning'] },
      })
    ).rejects.toMatchObject({ code: 'lesson_review_report_incomplete' });
  });

  test('allows source video to satisfy the visual pack without generated visuals', async () => {
    const draft: LessonContentDraft = {
      ...original,
      contentBlocks: [
        ...original.contentBlocks,
        {
          type: 'youtube-clips',
          clips: [{ sourceIndex: 0, startSeconds: 0, endSeconds: 10, title: 'Ordinamento' }],
        },
      ],
    };
    mockReview(draft, preserved, { checkId: 'generated-visual', status: 'not-applicable' });
    await expect(
      reviewLessonContentDraftStrict({
        draft,
        generationInput: { ...generationInput, instructionPacks: ['visual-learning'] },
      })
    ).resolves.toEqual(draft);
  });

  test.each([
    'pass',
    'failed',
  ])('reports unauthorized structures alongside %s semantic checks', async status => {
    const draft = {
      ...original,
      imageRefs: [{ assetId: 'unrequested', alt: 'Diagramma', caption: 'Relazioni ordinate.' }],
    };
    const checkId = 'core.progression';
    mockReview(draft, preserved, { checkId, status });
    const error = await review().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code:
        status === 'failed'
          ? 'lesson_review_checks_failed'
          : 'lesson_review_unchecked_structural_feature',
      feedback: expect.stringContaining('image-reference'),
    });
    if (status === 'failed') {
      expect(error).toMatchObject({ feedback: expect.stringContaining(checkId) });
    }
  });

  test('returns corrected quiz text without restoring the original stray token', async () => {
    const repaired = structuredClone(flawedAutomationLesson);
    const quiz = repaired.contentBlocks[1];
    if (quiz.type !== 'inline-quiz') throw new Error('Expected the fixture quiz.');
    quiz.quiz.question = 'Quale autorizzazione serve per inviare i promemoria?';
    mockReview(repaired, preserved, {
      action: 'Removed the unrelated type fragment from the question.',
      checkId: 'core.integrity',
      evidence: 'The question asks only about the authorized action.',
      status: 'corrected',
    });
    await expect(
      reviewLessonContentDraftStrict({ draft: flawedAutomationLesson, generationInput })
    ).resolves.toEqual(repaired);
  });
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
    expect(runCodexAppServerTurn.mock.calls[0][0].reasoningEffort).toBe('medium');
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
