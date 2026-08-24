import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
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
