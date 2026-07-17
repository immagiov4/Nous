import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { YouTubeResearchContext } from '../../../services/openrouter/youtubeResearchClient.ts';
import type { UserProfile } from '../../../types.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());
const appendGeneratedVisualExampleMock = vi.fn(
  async ({ contentMarkdown }: { contentMarkdown: string }) => ({
    content: contentMarkdown,
    generatedVisuals: [],
  })
);
const generateLessonLearningAidsMock = vi.fn(
  async (_options: {
    contentMarkdown: string;
    sectionDescription: string;
    sectionTitle: string;
  }) => [
    {
      id: 'learning-aid-definition-bytecode',
      kind: 'definition' as const,
      title: 'Bytecode',
      content: 'Formato intermedio eseguito dalla JVM.',
    },
  ]
);
const generateStandaloneLessonQuizMock = vi.fn(async () => []);
const getYouTubeResearchContextMock = vi.fn(
  async (_query: string, _language: string): Promise<YouTubeResearchContext> => ({
    context: '',
    videoCandidates: [],
    videoClipsEnabled: false,
  })
);

vi.mock('../../../services/openrouter/youtubeResearchClient.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../services/openrouter/youtubeResearchClient.ts')>();
  return {
    ...actual,
    getYouTubeResearchContext: getYouTubeResearchContextMock,
  };
});

vi.mock('../../../services/openrouter/lessonImages.ts', () => ({
  appendGeneratedVisualExample: appendGeneratedVisualExampleMock,
}));

vi.mock('../../../services/openrouter/learningAids.ts', () => ({
  generateLessonLearningAids: generateLessonLearningAidsMock,
}));

vi.mock('../../../services/openrouter/lessonMarkdownQuality/index.ts', () => ({
  generateStandaloneLessonQuiz: generateStandaloneLessonQuizMock,
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
  generateResearchLessonContent,
  generateResearchLessonDossier,
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
  appendGeneratedVisualExampleMock.mockClear();
  generateLessonLearningAidsMock.mockClear();
  generateStandaloneLessonQuizMock.mockClear();
  getYouTubeResearchContextMock.mockReset();
  getYouTubeResearchContextMock.mockResolvedValue({
    context: '',
    videoCandidates: [],
    videoClipsEnabled: false,
  });
});

test('course research evaluates automatic YouTube context', async () => {
  getYouTubeResearchContextMock.mockResolvedValue({
    context:
      'SOURCE Kotlin Course\nURL: https://www.youtube.com/watch?v=kotlin\n[00:10] JVM bytecode',
    videoCandidates: [],
    videoClipsEnabled: false,
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

  assert.equal(getYouTubeResearchContextMock.mock.calls[0]?.[0], 'Kotlin Android');
  assert.equal(
    callOpenRouterMock.mock.calls[0]?.[0]?.messages[0]?.content.includes(
      'https://www.youtube.com/watch?v=kotlin'
    ),
    true
  );
});

test('course research keeps only bounded YouTube clip metadata when backend policy allows it', async () => {
  getYouTubeResearchContextMock.mockResolvedValue({
    context:
      'SOURCE Drawing demo\nURL: https://www.youtube.com/watch?v=M7lc1UVf-VE\n[01:05-01:32] Traccio le linee di ombra.',
    videoCandidates: [
      {
        ranges: [{ startSeconds: 65, endSeconds: 93 }],
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
                      videoStartSeconds: 65.8,
                      videoEndSeconds: 92.2,
                    },
                    {
                      title: 'Clip eccessivo',
                      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
                      note: '',
                      videoStartSeconds: 0,
                      videoEndSeconds: 500,
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

  assert.deepEqual(result.researchCoursePlan.lessons[0]?.sourceHints[0]?.videoClip, {
    startSeconds: 65,
    endSeconds: 92,
  });
  assert.equal(result.researchCoursePlan.lessons[0]?.sourceHints[1]?.videoClip, undefined);
});

test('YouTube lab runs the production lesson pipeline and preserves only evidenced clips', async () => {
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
          videoStartSeconds: 65,
          videoEndSeconds: 92,
        },
        {
          title: 'Intervallo non supportato',
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          note: 'Fuori dal transcript disponibile.',
          videoStartSeconds: 200,
          videoEndSeconds: 240,
        },
      ],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
      youtubeCandidateDecisions: [
        {
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          decision: 'selected-clip',
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
      videoCandidates: [
        {
          ranges: [{ startSeconds: 65, endSeconds: 93 }],
          url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        },
      ],
      videoClipsEnabled: true,
    },
  });

  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.match(
    callOpenRouterMock.mock.calls[1]?.[0]?.messages[0]?.content || '',
    /YOUTUBE CANDIDATES TO CLASSIFY:[\s\S]*M7lc1UVf-VE/
  );
  assert.deepEqual(result.model.attempts, { research: 1, structuring: 1, total: 2 });
  assert.equal(result.researchBrief, 'Brief che valuta due candidati YouTube.');
  assert.equal(
    result.youtubeCandidateDecisions[0]?.reason,
    'Mostra la costruzione pratica della curva.'
  );
  assert.deepEqual(result.dossier.sources[0]?.videoClip, {
    startSeconds: 65,
    endSeconds: 92,
  });
  assert.equal(result.dossier.sources[1]?.videoClip, undefined);
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
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_schema');
});

test('lesson YouTube discovery includes practical plan details in its bounded query', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief con fonti video pratiche.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      factualSummary: 'Le curve pixel art usano gradini regolari.',
      keyExamples: [],
      difficultSteps: [],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
      sources: [],
    })
  );

  await generateResearchLessonDossier({
    lesson: {
      id: 'pixel-curves',
      title: 'Bordi e curve',
      description: 'Costruire curve, sfumature e texture leggibili',
      isCompleted: false,
      type: 'core',
    },
    moduleTitle: 'Tecniche',
    profile: { ...profile, topic: 'Pixel art' },
    researchCoursePlan: {
      generatedAt: '2026-07-17T00:00:00.000Z',
      lessonCountReason: 'Percorso pratico',
      lessons: [
        {
          description: 'Costruire forme leggibili',
          guidingQuestions: ['Come si evitano diagonali irregolari?'],
          id: 'pixel-curves',
          keyConcepts: ['sfumature', 'texture'],
          miniLab: 'Disegnare una curva a gradini',
          moduleId: 'techniques',
          moduleTitle: 'Tecniche',
          prerequisites: [],
          simplificationRisks: [],
          sourceHints: [{ title: 'Tutorial shading', note: 'Dimostrazione sul canvas' }],
          title: 'Bordi e curve',
        },
      ],
      summary: 'Corso di pixel art',
      title: 'Pixel art',
    },
    onStatusUpdate: () => {},
  });

  const query = getYouTubeResearchContextMock.mock.calls[0]?.[0] || '';
  assert.equal(query.includes('Bordi e curve Pixel art'), true);
  assert.equal(query.includes('sfumature texture'), true);
  assert.equal(query.includes('Disegnare una curva a gradini'), true);
  assert.equal(query.length <= 500, true);
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

test('generateResearchLessonDossier keeps sources optional and attaches the section id', async () => {
  getYouTubeResearchContextMock.mockResolvedValue({
    context:
      'SOURCE Kotlin lesson\nURL: https://www.youtube.com/watch?v=kotlin-lesson\n[00:10] JVM bytecode',
    videoCandidates: [],
    videoClipsEnabled: false,
  });
  callOpenRouterMock.mockResolvedValueOnce(
    'Kotlin gira sulla JVM. Esempio classico: hello world. Distinguere linguaggio e runtime e un punto delicato.'
  );
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      factualSummary: 'Kotlin gira sulla JVM e compila a bytecode.',
      keyExamples: ['Hello world'],
      difficultSteps: ['Distinguere linguaggio e runtime'],
      avoidOversimplifying: ['Non ridurre Kotlin a Java corto'],
      controversies: [],
    })
  );

  const onReasoningUpdate = vi.fn();
  const dossier = await generateResearchLessonDossier({
    lesson: {
      id: 'lesson-1',
      title: 'Perche Kotlin',
      description: 'Motivazione',
      isCompleted: false,
      type: 'core',
      contextPrompt: 'Spiega Kotlin',
    },
    moduleTitle: 'Fondamenti',
    profile,
    researchCoursePlan: null,
    onStatusUpdate: () => {},
    onReasoningUpdate,
  });

  assert.equal(dossier.sectionId, 'lesson-1');
  assert.equal(dossier.factualSummary.includes('JVM'), true);
  assert.deepEqual(dossier.sources, []);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.tools, undefined);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.onReasoningUpdate, onReasoningUpdate);
  assert.equal(
    callOpenRouterMock.mock.calls[0]?.[0]?.messages[0]?.content.includes(
      'https://www.youtube.com/watch?v=kotlin-lesson'
    ),
    true
  );
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_schema');
});

test('generateResearchLessonDossier searches with the lesson model only for coverage gaps', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief supplementare con fonti web.');
  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      factualSummary: 'Il dossier integra soltanto i prerequisiti mancanti.',
      keyExamples: [],
      difficultSteps: [],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
      sources: [],
    })
  );

  await generateResearchLessonDossier({
    coverageGaps: ['Ipotesi matematiche', 'Limiti del metodo'],
    lesson: {
      id: 'lesson-with-gaps',
      title: 'Metodo numerico',
      description: 'Applicare il metodo',
      isCompleted: false,
      type: 'core',
      contextPrompt: 'Spiega il metodo',
    },
    moduleTitle: 'Metodi',
    profile,
    researchCoursePlan: null,
    onStatusUpdate: () => {},
  });

  const researchRequest = callOpenRouterMock.mock.calls[0]?.[0];
  assert.equal(researchRequest?.modelSlot, 'lesson');
  assert.deepEqual(researchRequest?.tools, [{ type: 'openrouter:web_search' }]);
  assert.equal(researchRequest?.messages[0]?.content.includes('Ipotesi matematiche'), true);
  assert.equal(researchRequest?.messages[0]?.content.includes('Limiti del metodo'), true);
});

test('generateResearchLessonContent returns contextual learning aids with the lesson', async () => {
  callOpenRouterMock.mockResolvedValue('## Kotlin e JVM\n\nKotlin compila in bytecode per la JVM.');

  const result = await generateResearchLessonContent({
    lessonTitle: 'Kotlin e JVM',
    moduleTitle: 'Fondamenti',
    contextPrompt: 'Spiega la relazione tra Kotlin, bytecode e JVM.',
    profile,
    syllabus: [],
    researchDossier: {
      sectionId: 'lesson-1',
      title: 'Kotlin e JVM',
      generatedAt: '2026-05-12T12:00:00.000Z',
      factualSummary: 'Kotlin compila in bytecode.',
      keyExamples: [],
      difficultSteps: [],
      sources: [],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
    },
    onStatusUpdate: () => {},
  });

  assert.equal(result.learningAids[0]?.title, 'Bytecode');
  assert.deepEqual(generateLessonLearningAidsMock.mock.calls[0]?.[0], {
    contentMarkdown: '## Kotlin e JVM\n\nKotlin compila in bytecode per la JVM.',
    sectionDescription: 'Spiega la relazione tra Kotlin, bytecode e JVM.',
    sectionTitle: 'Kotlin e JVM',
  });
});

test('generateResearchLessonContent leaves structured source attribution out of lesson markdown', async () => {
  callOpenRouterMock.mockResolvedValue(
    '## Fondamenti\n\nSpiegazione verificata.\n\n## Fonti essenziali\n\n- Fonte inventata'
  );

  const result = await generateResearchLessonContent({
    lessonTitle: 'Fondamenti',
    moduleTitle: 'Basi',
    contextPrompt: 'Spiega i prerequisiti.',
    profile,
    syllabus: [],
    originalSourceContext: 'FONTE ORIGINALE: dispensa.pdf\nEstratto rilevante.',
    researchDossier: {
      sectionId: 'lesson-prerequisite',
      title: 'Fondamenti',
      generatedAt: '2026-07-11T10:00:00.000Z',
      factualSummary: 'Fondamento verificato.',
      keyExamples: [],
      difficultSteps: [],
      sources: [
        { title: 'dispensa.pdf', note: 'Materiale originale del corso' },
        { title: 'Documentazione ufficiale', url: 'https://example.com/docs' },
      ],
      avoidOversimplifying: [],
      controversies: [],
      recentDevelopments: [],
    },
    onStatusUpdate: () => {},
  });

  assert.equal(result.content, '## Fondamenti\n\nSpiegazione verificata.');
});
