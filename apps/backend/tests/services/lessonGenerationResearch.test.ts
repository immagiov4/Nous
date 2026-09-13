import { APICallError } from 'ai';
import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { CodexAppServerError } from '../../src/services/codexAppServer.js';
import {
  buildResearchDossier,
  generateLessonResearchSummary,
  shouldGenerateLessonResearch,
} from '../../src/services/lessonGenerationResearch.js';
import type { LessonGenerationInput } from '../../src/services/lessonGenerationTypes.js';

const generationInput = (
  overrides: Partial<LessonGenerationInput> = {}
): LessonGenerationInput => ({
  config: getGlobalModelConfig(),
  description: 'Descrizione',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext: '',
  previousLessonTitles: [],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Titolo',
  signal: new AbortController().signal,
  sourceContext: 'Materiale originale sufficiente.',
  sources: [],
  ...overrides,
});

const researchSummary = {
  avoidOversimplifying: [],
  controversies: [],
  difficultSteps: [],
  factualSummary: 'Sintesi',
  keyExamples: [],
  recentDevelopments: [],
  sources: [],
  youtubeCandidateDecisions: [],
};

const youtubeOutcome = {
  context: 'Transcript verificato',
  discoveredVideoCount: 1,
  rationale: 'Candidato pertinente',
  videoCandidates: [
    {
      segments: [{ endSeconds: 5, startSeconds: 0, text: 'Spiegazione' }],
      title: 'Video',
      url: 'https://www.youtube.com/watch?v=video-1',
    },
  ],
};

describe('lesson research routing', () => {
  test.each([
    'empty',
    'web',
    'youtube',
  ] as const)('validates combined required evidence: %s', async evidence => {
    const summary = {
      ...researchSummary,
      factualSummary: evidence === 'web' ? 'Verified facts' : ' \n ',
      youtubeCandidateDecisions:
        evidence === 'youtube'
          ? [
              {
                url: youtubeOutcome.videoCandidates[0].url,
                decision: 'selected-source',
                rationale: 'Relevant evidence',
              },
            ]
          : [],
    };
    const result = generateLessonResearchSummary({
      existingDossier: null,
      generationInput: generationInput({
        researchRouting: {
          suppliedSourcesSufficient: false,
          rationale: 'Required evidence',
          channels: [
            { type: 'web', selected: true, rationale: 'Facts' },
            { type: 'youtube', selected: true, rationale: 'Demonstration' },
          ],
        },
      }),
      research: vi.fn().mockResolvedValue(summary),
      youtubeOutcome: evidence === 'youtube' ? youtubeOutcome : null,
    });
    if (evidence === 'empty') {
      await expect(result).rejects.toMatchObject({
        failure: { kind: 'permanent', code: 'research_evidence_missing' },
      });
    } else {
      await expect(result).resolves.toBe(summary);
    }
  });
  test.each([
    '',
    ' \n ',
  ])('corrects empty required web research while retaining optional results', async factualSummary => {
    const input = generationInput({
      researchRouting: {
        suppliedSourcesSufficient: false,
        rationale: 'Required facts',
        channels: [
          { type: 'web', selected: true, rationale: 'Current facts' },
          { type: 'youtube', selected: false, rationale: 'Text only' },
        ],
      },
    });
    const research = vi.fn().mockResolvedValue({ ...researchSummary, factualSummary });
    const args = { existingDossier: null, generationInput: input, research, youtubeOutcome: null };
    const failure = await generateLessonResearchSummary(args).catch(error => error);
    expect(failure.failure).toMatchObject({
      kind: 'corrective',
      code: 'research_web_evidence_missing',
    });
    research.mockResolvedValue(researchSummary);
    await expect(generateLessonResearchSummary(args)).resolves.toBe(researchSummary);
    if (!input.researchRouting) throw new Error('Missing test routing');
    input.researchRouting.suppliedSourcesSufficient = true;
    research.mockResolvedValue({ ...researchSummary, factualSummary });
    await expect(generateLessonResearchSummary(args)).resolves.toMatchObject({ factualSummary });
  });
  test('omits a new YouTube record without an outcome and retains an existing record', () => {
    const input = {
      contentBlocks: [],
      existingDossier: null,
      lessonSources: [],
      researchSummary: null,
      sectionId: 'lesson-1',
      sectionTitle: 'Lesson',
      youtubeOutcome: null,
    };
    expect(buildResearchDossier(input)).not.toHaveProperty('youtubeResearch');
    const previous = {
      candidateDecisions: [],
      outcome: 'completed',
      rationale: 'Previously completed research',
    };
    expect(
      buildResearchDossier({ ...input, existingDossier: { youtubeResearch: previous } })
        .youtubeResearch
    ).toEqual(previous);
  });
  test.each([
    null,
    { ...youtubeOutcome, videoCandidates: [] },
  ])('requires evidence when YouTube is the only necessary channel', async emptyOutcome => {
    const research = vi.fn().mockResolvedValue(researchSummary);
    const input = generationInput({
      researchRouting: {
        suppliedSourcesSufficient: false,
        rationale: 'Evidence needed',
        channels: [
          { type: 'web', selected: false, rationale: 'No web evidence needed' },
          { type: 'youtube', selected: true, rationale: 'Required demonstration' },
        ],
      },
    });
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: emptyOutcome,
      })
    ).rejects.toThrow('Required YouTube research');
    expect(research).not.toHaveBeenCalled();
    if (!input.researchRouting) throw new Error('Missing test routing');
    input.researchRouting.suppliedSourcesSufficient = true;
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: emptyOutcome,
      })
    ).resolves.toBeNull();
    input.researchRouting.suppliedSourcesSufficient = false;
    input.researchRouting.channels[0].selected = true;
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: emptyOutcome,
      })
    ).resolves.toBe(researchSummary);
    expect(research).toHaveBeenCalledTimes(1);
  });
  test.each([
    new CodexAppServerError('Unavailable', 'process'),
    new CodexAppServerError('Unavailable', 'timeout'),
    new APICallError({
      message: 'Unavailable',
      statusCode: 503,
      url: 'https://example.com',
      requestBodyValues: {},
    }),
  ])('continues from sufficient supplied sources on an optional provider failure: %s', async error => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = generationInput({
      researchRouting: {
        suppliedSourcesSufficient: true,
        rationale: 'Enough factual sources, current examples optional.',
        channels: [
          { type: 'web', selected: true, rationale: 'Current examples.' },
          { type: 'youtube', selected: false, rationale: 'No demonstration needed.' },
        ],
      },
    });
    const research = vi.fn().mockRejectedValue(error);
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: null,
      })
    ).rejects.toBe(error);
    await expect(
      generateLessonResearchSummary({
        allowOptionalFailure: true,
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: null,
      })
    ).resolves.toBeNull();
    expect(research).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    if (!input.researchRouting) throw new Error('Missing test routing.');
    input.researchRouting.channels = [
      { type: 'web', selected: false, rationale: 'No web evidence needed.' },
      { type: 'youtube', selected: true, rationale: 'Optional demonstration.' },
    ];
    await expect(
      generateLessonResearchSummary({
        allowOptionalFailure: true,
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome,
      })
    ).resolves.toBeNull();
    if (!input.researchRouting) throw new Error('Missing test routing.');
    input.researchRouting.suppliedSourcesSufficient = false;
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome,
      })
    ).rejects.toThrow('Unavailable');
    expect(research).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  test('preserves contract errors and cancellation even with sufficient sources', async () => {
    const controller = new AbortController();
    const input = generationInput({
      signal: controller.signal,
      researchRouting: {
        suppliedSourcesSufficient: true,
        rationale: 'Enough.',
        channels: [{ type: 'web', selected: true, rationale: 'Optional examples.' }],
      },
    });
    const research = vi.fn();
    for (const error of [
      new SyntaxError('Invalid structured response'),
      new CodexAppServerError('Invalid model response', 'protocol'),
      new CodexAppServerError('Disabled configuration', 'disabled'),
      new CodexAppServerError('Missing authentication', 'not_authenticated'),
      ...[400, 401].map(
        statusCode =>
          new APICallError({
            message: 'Invalid request',
            statusCode,
            url: 'https://example.com',
            requestBodyValues: {},
          })
      ),
    ]) {
      research.mockRejectedValue(error);
      await expect(
        generateLessonResearchSummary({
          existingDossier: null,
          generationInput: input,
          research,
          youtubeOutcome: null,
        })
      ).rejects.toBe(error);
    }
    controller.abort(new Error('Cancelled'));
    research.mockRejectedValue(new CodexAppServerError('Unavailable', 'process'));
    await expect(
      generateLessonResearchSummary({
        existingDossier: null,
        generationInput: input,
        research,
        youtubeOutcome: null,
      })
    ).rejects.toThrow('Cancelled');
  });

  test('does not call a provider for source-backed material without gaps or video candidates', async () => {
    const research = vi.fn().mockResolvedValue(researchSummary);
    const input = generationInput();

    const result = await generateLessonResearchSummary({
      existingDossier: null,
      generationInput: input,
      research,
      youtubeOutcome: null,
    });

    expect(result).toBeNull();
    expect(research).not.toHaveBeenCalled();
  });

  test('researches a source-backed lesson only for declared gaps', () => {
    expect(shouldGenerateLessonResearch(generationInput())).toBe(false);
    expect(
      shouldGenerateLessonResearch(
        generationInput({ coverageGaps: ['Manca la relazione happens-before.'] })
      )
    ).toBe(true);
  });

  test('keeps research enabled for source-free lessons', () => {
    expect(shouldGenerateLessonResearch(generationInput({ sourceContext: '' }))).toBe(true);
  });

  test('rebuilds supplemental research when the lesson is explicitly regenerated', async () => {
    const research = vi.fn().mockResolvedValue(researchSummary);
    const input = generationInput({ refreshResearch: true });

    const result = await generateLessonResearchSummary({
      existingDossier: { factualSummary: 'Dossier precedente' },
      generationInput: input,
      research,
      youtubeOutcome: null,
    });

    expect(result).toEqual(researchSummary);
    expect(research).toHaveBeenCalledOnce();
  });

  test('still classifies discovered videos without enabling supplemental source research', async () => {
    const research = vi.fn().mockResolvedValue({
      ...researchSummary,
      youtubeCandidateDecisions: [
        {
          decision: 'selected-source',
          reason: 'Il transcript spiega il concetto.',
          url: 'https://www.youtube.com/watch?v=video-1',
        },
      ],
    });
    const input = generationInput();

    const result = await generateLessonResearchSummary({
      existingDossier: null,
      generationInput: input,
      research,
      youtubeOutcome,
    });

    expect(result?.youtubeCandidateDecisions).toHaveLength(1);
    expect(research).toHaveBeenCalledOnce();
  });

  test('rejects duplicate YouTube decisions instead of accepting incomplete one-to-one classification', async () => {
    const duplicateDecision = {
      decision: 'selected-source' as const,
      reason: 'Il transcript spiega il concetto.',
      url: 'https://www.youtube.com/watch?v=video-1',
    };
    const research = vi.fn().mockResolvedValue({
      ...researchSummary,
      youtubeCandidateDecisions: [duplicateDecision, duplicateDecision],
    });

    const error = await generateLessonResearchSummary({
      existingDossier: null,
      generationInput: generationInput(),
      research,
      youtubeOutcome,
    }).catch(value => value);

    expect(error).toMatchObject({
      code: 'lesson_research_candidate_classification_incomplete',
      feedback: expect.stringContaining('exactly one youtubeCandidateDecisions entry'),
    });
  });

  test('keeps original sources primary while adding sanitized web citations to the dossier', () => {
    const dossier = buildResearchDossier({
      contentBlocks: [{ markdown: 'Lezione', type: 'markdown' }],
      existingDossier: null,
      generatedAt: '2026-07-29T22:00:00.000Z',
      lessonSources: [
        {
          chunkIds: ['chunk-1'],
          note: 'Materiale originale',
          sourceId: 'source-1',
          title: 'Dispensa.pdf',
        },
      ],
      researchSummary: {
        ...researchSummary,
        sources: [
          {
            note: 'Colma la lacuna dichiarata',
            title: 'Documentazione autorevole',
            url: 'https://example.com/reference',
          },
        ],
      },
      sectionId: 'lesson-1',
      sectionTitle: 'Titolo',
      youtubeOutcome: null,
    });

    expect(dossier.sources).toEqual([
      expect.objectContaining({ sourceId: 'source-1', title: 'Dispensa.pdf' }),
      expect.objectContaining({
        title: 'Documentazione autorevole',
        url: 'https://example.com/reference',
      }),
    ]);
  });
});
