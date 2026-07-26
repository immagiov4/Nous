import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { YouTubeResearchContext } from '../../../services/openrouter/youtubeResearchClient.ts';
import type { UserProfile } from '../../../types.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());
const getYouTubeResearchContextMock = vi.fn(
  async (_query: string, _language: string): Promise<YouTubeResearchContext> => ({
    context: '',
    rationale: 'Nessun candidato disponibile.',
    videoCandidates: [],
    videoClipsEnabled: false,
  })
);
const planYouTubeSearchQueryMock = vi.fn(async (_input: unknown) => ({
  fallbackQuery: 'pixel art curve tutorial',
  focusConcept: 'pixel art curve shading',
  specificQuery: 'pixel art curve shading tutorial',
}));
const planCourseYouTubeSearchQueriesMock = vi.fn(async (_input: unknown) => [
  'kotlin fundamentals course',
  'kotlin complete playlist',
  'kotlin android practical tutorial',
]);

vi.mock('../../../services/openrouter/youtubeResearchClient.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../services/openrouter/youtubeResearchClient.ts')>();
  return {
    ...actual,
    getYouTubeResearchContext: getYouTubeResearchContextMock,
  };
});

vi.mock('../../../services/openrouter/youtubeSearchQuery.ts', () => ({
  planCourseYouTubeSearchQueries: planCourseYouTubeSearchQueriesMock,
  planYouTubeSearchQuery: planYouTubeSearchQueryMock,
}));

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
  };
});

const {
  buildLearningPlanFromResearchCourse,
  evaluateYouTubeResearchLab,
  generateResearchCoursePlan,
} = await import('../../../services/openrouter/research.ts');

const profile: UserProfile = {
  topic: 'Kotlin Android',
  experienceLevel: 'Base',
  learningStyle: 'Pratico',
  goals: 'Creare app Android',
  context: 'Studente con attenzione frammentata',
  language: 'Italiano',
};

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getYouTubeResearchContextMock.mockReset();
  planCourseYouTubeSearchQueriesMock.mockClear();
  planYouTubeSearchQueryMock.mockClear();
  getYouTubeResearchContextMock.mockResolvedValue({
    context: '',
    rationale: 'Nessun candidato disponibile.',
    videoCandidates: [],
    videoClipsEnabled: false,
  });
});

test('course research evaluates automatic YouTube context', async () => {
  getYouTubeResearchContextMock.mockResolvedValue({
    context:
      'SOURCE Kotlin Course\nURL: https://www.youtube.com/watch?v=kotlin\n[00:10] JVM bytecode',
    rationale: 'Un transcript incluso.',
    videoCandidates: [
      {
        ranges: [{ startSeconds: 10, endSeconds: 20 }],
        title: 'Kotlin Course',
        transcript: '[00:10-00:20] JVM bytecode',
        url: 'https://www.youtube.com/watch?v=kotlin-lesson',
      },
    ],
    videoClipsEnabled: true,
  });
  callOpenRouterMock.mockResolvedValueOnce('Brief con fonte YouTube.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      title: 'Kotlin',
      summary: 'Corso',
      lessonCountReason: 'Percorso essenziale',
      modules: [
        {
          title: 'Fondamenti',
          description: 'Base',
          lessons: Array.from({ length: 8 }, (_, index) => ({
            title: `Lezione ${index + 1}`,
            description: 'Base',
            prerequisites: [],
            keyConcepts: [],
            guidingQuestions: [],
            miniLab: '',
            sourceHints: [],
            simplificationRisks: [],
          })),
        },
      ],
    })
  );

  await generateResearchCoursePlan(
    profile,
    () => {},
    () => {}
  );

  assert.deepEqual(
    getYouTubeResearchContextMock.mock.calls.map(call => call[0]),
    ['kotlin fundamentals course', 'kotlin complete playlist', 'kotlin android practical tutorial']
  );
  assert.equal(
    callOpenRouterMock.mock.calls[0]?.[0]?.messages.some((message: { content: string }) =>
      message.content.includes('https://www.youtube.com/watch?v=kotlin')
    ),
    false
  );
  assert.equal(
    callOpenRouterMock.mock.calls[1]?.[0]?.messages.some((message: { content: string }) =>
      message.content.includes('https://www.youtube.com/watch?v=kotlin')
    ),
    true
  );
});

test('course research keeps useful YouTube videos as source hints without choosing clips', async () => {
  getYouTubeResearchContextMock.mockResolvedValue({
    context:
      'SOURCE Drawing demo\nURL: https://www.youtube.com/watch?v=M7lc1UVf-VE\n[01:05-01:32] Traccio le linee di ombra.',
    rationale: 'Un transcript incluso.',
    videoCandidates: [
      {
        ranges: [{ startSeconds: 65, endSeconds: 93 }],
        title: 'Drawing demo',
        transcript: '[01:05-01:33] Traccio le linee di ombra.',
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      },
    ],
    videoClipsEnabled: true,
  });
  callOpenRouterMock.mockResolvedValueOnce('Brief con una dimostrazione pratica verificata.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      title: 'Disegno',
      summary: 'Corso pratico',
      lessonCountReason: 'Percorso essenziale',
      modules: [
        {
          title: 'Fondamenti',
          description: 'Base',
          lessons: Array.from({ length: 8 }, (_, index) => ({
            title: `Lezione ${index + 1}`,
            description: 'Base',
            prerequisites: [],
            keyConcepts: [],
            guidingQuestions: [],
            miniLab: '',
            sourceHints:
              index === 0
                ? [
                    {
                      title: 'Ombreggiatura',
                      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
                      note: 'Mostra il movimento della matita.',
                    },
                  ]
                : [],
            simplificationRisks: [],
          })),
        },
      ],
    })
  );

  const result = await generateResearchCoursePlan(
    { ...profile, topic: 'Disegno' },
    () => {},
    () => {}
  );

  assert.equal(
    result.researchCoursePlan.lessons[0]?.sourceHints[0]?.url,
    'https://www.youtube.com/watch?v=M7lc1UVf-VE'
  );
  assert.equal(result.researchCoursePlan.lessons[0]?.sourceHints[0]?.videoClip, undefined);
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
          ranges: [{ startSeconds: 65, endSeconds: 93 }],
          title: 'Curve a gradini',
          transcript: '[01:05-01:33] Traccio una curva a gradini sul canvas.',
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
    ranges: [{ startSeconds: 65, endSeconds: 93 }],
    text: '[01:05-01:33] Traccio una curva a gradini sul canvas.',
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

test('course research streams progress while gathering sources', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief con fonti.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      title: 'Kotlin',
      summary: 'Corso',
      lessonCountReason: 'Percorso essenziale',
      modules: [
        {
          title: 'Fondamenti',
          description: 'Base',
          lessons: Array.from({ length: 8 }, (_, index) => ({
            title: `Lezione ${index + 1}`,
            description: 'Base',
          })),
        },
      ],
    })
  );
  const onReasoningUpdate = vi.fn();

  await generateResearchCoursePlan(
    profile,
    () => {},
    () => {},
    onReasoningUpdate
  );

  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.onReasoningUpdate, onReasoningUpdate);
});

test('generateResearchCoursePlan normalizes course shape and clamps oversized outlines', async () => {
  callOpenRouterMock.mockResolvedValueOnce(
    'Brief: Kotlin runs on the JVM. Modules should cover fondamenti, GUI e tooling. Fonti: https://kotlinlang.org/docs/home.html.'
  );
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      title: 'Kotlin Android',
      summary: 'Corso pratico',
      lessonCountReason: 'Argomento ampio',
      modules: [
        {
          title: 'Fondamenti',
          description: 'Base',
          lessons: Array.from({ length: 30 }, (_, index) => ({
            title: `Lezione ${index + 1}`,
            description: `Descrizione ${index + 1}`,
            keyConcepts: [`Concetto ${index + 1}`],
            guidingQuestions: [`Domanda ${index + 1}`],
            miniLab: 'Esercizio',
            sourceHints: [{ title: 'Kotlin docs', url: 'https://kotlinlang.org/docs/home.html' }],
            simplificationRisks: ['Non banalizzare'],
          })),
        },
      ],
    })
  );

  const result = await generateResearchCoursePlan(
    profile,
    () => {},
    () => {}
  );

  assert.equal(result.researchCoursePlan.lessons.length, 24);
  assert.equal(result.syllabus[0]?.children?.length, 24);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.modelSlot, 'course');
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.tools, [
    { type: 'openrouter:web_search' },
  ]);
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_schema');
});

test('buildLearningPlanFromResearchCourse preserves research syllabus modules', () => {
  const plan = buildLearningPlanFromResearchCourse(
    profile,
    {
      generatedAt: '2026-05-12T12:00:00.000Z',
      lessonCountReason: 'Two distinct areas',
      title: 'Kotlin Android',
      summary: 'Corso pratico',
      lessons: [],
    },
    [
      {
        id: 'mod-1',
        title: 'Fondamenti',
        description: 'Base',
        type: 'module',
        status: 'ready',
        children: [
          {
            id: 'mod-1-lesson-1',
            title: 'Sintassi Kotlin',
            description: 'Capire la sintassi',
            type: 'lesson',
            status: 'pending',
            contextPrompt: 'Spiega la sintassi Kotlin',
          },
        ],
      },
      {
        id: 'mod-2',
        title: 'Android operativo',
        description: 'Pratica',
        type: 'module',
        status: 'ready',
        children: [
          {
            id: 'mod-2-lesson-1',
            title: 'Activity e lifecycle',
            description: 'Capire il lifecycle',
            type: 'lesson',
            status: 'pending',
            contextPrompt: 'Spiega il lifecycle Android',
          },
        ],
      },
    ]
  );

  assert.deepEqual(
    plan.modules.map(module => module.title),
    ['Fondamenti', 'Android operativo']
  );
  assert.deepEqual(
    plan.modules.map(module => module.children.map(lesson => lesson.title)),
    [['Sintassi Kotlin'], ['Activity e lifecycle']]
  );
});

test('buildLearningPlanFromResearchCourse leaves application exercises to the placement pass', () => {
  const plan = buildLearningPlanFromResearchCourse(
    profile,
    {
      generatedAt: '2026-05-12T12:00:00.000Z',
      lessonCountReason: 'Operational course',
      title: 'Sistemistica PMI',
      summary: 'Corso pratico',
      lessons: [
        {
          id: 'mod-1-lesson-1',
          title: 'Mappare host e servizi',
          description: 'Capire cosa esiste in rete',
          moduleId: 'mod-1',
          moduleTitle: 'Fondamenti operativi',
          prerequisites: [],
          keyConcepts: ['inventario', 'servizi'],
          guidingQuestions: [],
          miniLab: 'Disegna una mappa minima con host, IP, servizi e dipendenze.',
          simplificationRisks: [],
          sourceHints: [],
        },
      ],
    },
    [
      {
        id: 'mod-1',
        title: 'Fondamenti operativi',
        description: 'Base',
        type: 'module',
        status: 'ready',
        children: [
          {
            id: 'mod-1-lesson-1',
            title: 'Mappare host e servizi',
            description: 'Capire cosa esiste in rete',
            type: 'lesson',
            status: 'pending',
            contextPrompt: 'Spiega inventario e servizi',
          },
        ],
      },
    ]
  );

  const module = plan.modules[0];
  assert.equal(module?.children.length, 1);
  assert.equal(module?.children[0]?.kind, 'lesson');
  assert.equal(plan.applicationExercisePlanningStatus, 'not-run');
});
