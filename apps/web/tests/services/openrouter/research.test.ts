import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { UserProfile } from '../../../types.ts';

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

const { generateResearchCoursePlan, generateResearchLessonDossier } = await import(
  '../../../services/openrouter/research.ts'
);

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
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.disableModelOverride, true);
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_object');
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
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.disableModelOverride, true);
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.response_format?.type, 'json_object');
});
