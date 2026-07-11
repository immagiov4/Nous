import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
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
  assert.equal(result.syllabus[0]?.children?.[0]?.contextPrompt?.includes('Concetti chiave'), true);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_object');
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
  });

  assert.equal(dossier.sectionId, 'lesson-1');
  assert.equal(dossier.factualSummary.includes('JVM'), true);
  assert.deepEqual(dossier.sources, []);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_object');
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
