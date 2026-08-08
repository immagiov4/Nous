import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
  };
});

const { evaluateYouTubeResearchLab } = await import('../../../services/openrouter/research.ts');

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
});

test('YouTube lab passes selected video transcripts to the lesson writer without choosing clips', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief che valuta due candidati YouTube.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      factualSummary: 'Le diagonali a gradini costruiscono curve leggibili.',
      keyExamples: [],
      difficultSteps: [],
      sources: [
        {
          title: 'Pixel art curves',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          note: 'Mostra la costruzione della curva sul canvas.',
        },
      ],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
      youtubeCandidateDecisions: [
        {
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          decision: 'selected-source',
          reason: 'Mostra la costruzione pratica della curva.',
        },
      ],
    })
  );

  const result = await evaluateYouTubeResearchLab({
    language: 'Italiano',
    lessonGoal: 'Bordi, curve e sfumature',
    topic: 'Pixel art',
    youtubeResearch: {
      context: '[01:05-01:32] Traccio una curva a gradini sul canvas.',
      rationale: 'Un transcript incluso.',
      videoCandidates: [
        {
          segments: [
            {
              startSeconds: 65,
              endSeconds: 93,
              text: 'Traccio una curva a gradini sul canvas.',
            },
          ],
          title: 'Curve a gradini',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
      videoClipsEnabled: true,
    },
  });

  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.match(
    callOpenRouterMock.mock.calls[1]?.[0]?.messages
      .map((message: { content: string }) => message.content)
      .join('\n') || '',
    /YOUTUBE CANDIDATES TO CLASSIFY:[\s\S]*M7lc1UVf-VE/
  );
  assert.deepEqual(result.model.attempts, { research: 1, structuring: 1, total: 2 });
  assert.equal(result.researchBrief, 'Brief che valuta due candidati YouTube.');
  assert.equal(
    result.youtubeCandidateDecisions[0]?.reason,
    'Mostra la costruzione pratica della curva.'
  );
  assert.deepEqual(result.dossier.sources[0]?.youtubeTranscript, {
    segments: [
      {
        startSeconds: 65,
        endSeconds: 93,
        text: 'Traccio una curva a gradini sul canvas.',
      },
    ],
  });
  assert.equal(result.dossier.sources[0]?.videoClip, undefined);
});

test('YouTube lab reports the effective attempts for both model stages', async () => {
  retryWithBackoffMock
    .mockImplementationOnce(async operation => {
      await operation().catch(() => undefined);
      return operation();
    })
    .mockImplementationOnce(async operation => {
      await operation().catch(() => undefined);
      return operation();
    });
  callOpenRouterMock
    .mockRejectedValueOnce(new Error('research retry'))
    .mockResolvedValueOnce('Brief riuscito al secondo tentativo.')
    .mockRejectedValueOnce(new Error('structuring retry'))
    .mockResolvedValueOnce(
      JSON.stringify({
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Sintesi.',
        keyExamples: [],
        recentDevelopments: [],
        sources: [],
        youtubeCandidateDecisions: [],
      })
    );

  const result = await evaluateYouTubeResearchLab({
    language: 'Italiano',
    topic: 'Pixel art',
    youtubeResearch: {
      context: '[00:10-00:20] Esempio.',
      rationale: 'Nessun candidato con intervalli utilizzabili.',
      videoCandidates: [],
      videoClipsEnabled: true,
    },
  });

  assert.deepEqual(result.model.attempts, { research: 2, structuring: 2, total: 4 });
});
