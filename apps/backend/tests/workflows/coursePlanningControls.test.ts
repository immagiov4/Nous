import {
  COURSE_CONTROL_POSITIONS,
  CoursePlanningControlsSchema,
  DEFAULT_COURSE_PLANNING_CONTROLS,
  resolveCoursePlanningControls,
} from '@shared/coursePlanningControls';
import { buildCoursePlanningInstructions } from '@shared/coursePlanningInstructions';
import { describe, expect, test } from 'vitest';
import { buildLessonGenerationInput } from '../../src/services/lessonGenerationPreparation';
import { buildLessonGenerationReferenceContext } from '../../src/services/lessonGenerationPrompt';
import { buildCoursePlanOutput } from '../../src/workflows/courseGenerationPlanning';
import { CourseResearchStateSchema } from '../../src/workflows/courseGenerationWorkflowContract';

const profile = {
  context: 'Preparare un esame',
  experienceLevel: 'Conosce array, indici e confronti',
  goals: 'Applicare la ricerca binaria su un array ordinato',
  language: 'Italiano',
  learningStyle: 'esempi',
  topic: 'Ricerca binaria',
};
const rawPlan = {
  title: 'Ricerca binaria',
  summary: 'Ridurre un intervallo ordinato.',
  lessonCountReason: 'Un risultato locale: aggiornare correttamente un intervallo.',
  modules: [
    {
      title: 'Intervalli',
      description: 'Ricerca in un array ordinato',
      type: 'core',
      lessons: [
        {
          title: 'Dimezzare l’intervallo',
          description: 'Scegliere la metà che può contenere il valore.',
          guidingQuestions: ['Quale metà può essere esclusa?'],
          instructionPacks: [],
          keyConcepts: ['Intervallo candidato'],
          miniLab: null,
          prerequisites: ['Array', 'Confronti'],
          simplificationRisks: ['Escludere il valore cercato'],
          sourceUrls: [],
          type: 'core',
        },
      ],
    },
  ],
};

describe('course planning controls', () => {
  test('preserves historical absence and resolves Auto against available sources', () => {
    expect(resolveCoursePlanningControls(undefined, true)).toBeUndefined();
    expect(resolveCoursePlanningControls(DEFAULT_COURSE_PLANNING_CONTROLS, true)).toEqual({
      depth: 'auto',
      granularity: 'auto',
      reference: 'source',
    });
    expect(resolveCoursePlanningControls(DEFAULT_COURSE_PLANNING_CONTROLS, false)).toEqual({
      depth: 'auto',
      granularity: 'auto',
      reference: 'balanced',
    });
    expect(
      CoursePlanningControlsSchema.safeParse({ depth: 0.5, granularity: 'auto' }).success
    ).toBe(false);
  });

  test.each(
    COURSE_CONTROL_POSITIONS.flatMap(depth =>
      (['document', 'codebase'] as const).map(sourceKind => ({ depth, sourceKind }))
    )
  )('carries $depth through $sourceKind checkpoints and lesson context', ({
    depth,
    sourceKind,
  }) => {
    const controls = { depth, granularity: 'auto' as const };
    const languageProficiency = { language: 'Italiano', level: 'B2' as const };
    const state = CourseResearchStateSchema.parse(
      JSON.parse(
        JSON.stringify({
          context: {
            profile: { ...profile, coursePlanningControls: controls, languageProficiency },
            assessmentSummary: '',
            language: 'Italiano',
            topic: profile.topic,
            sourceNames: ['Ricerca binaria'],
            sources: [
              {
                id: 'source',
                hash: 'a'.repeat(64),
                kind: 'text',
                mimeType: 'text/plain',
                name: 'Ricerca binaria',
              },
            ],
          },
          projectRevision: 1,
          request: { mode: 'document', projectId: 'course', userId: 'learner' },
          stage: 'research',
          strategy: 'single-source',
          research: {
            web: { brief: '', sources: [] },
            youtube: { candidates: [], context: '', rationale: '', status: 'unavailable' },
          },
        })
      )
    );
    expect(state.context.profile).toEqual({
      ...profile,
      coursePlanningControls: controls,
      languageProficiency,
    });
    const output = buildCoursePlanOutput(rawPlan, state, '2026-09-10T12:00:00Z');
    const persistedPlan = JSON.parse(JSON.stringify(output.plan));
    expect(persistedPlan.generationNotes).toBeUndefined();
    const section = persistedPlan.modules[0].children[0];
    const { generationInput } = buildLessonGenerationInput({
      config: {} as never,
      signal: new AbortController().signal,
      researchSources: [],
      section,
      sectionId: section.id,
      sourceContext: 'Confrontare il valore con l’elemento centrale.',
      project: {
        id: 'course',
        version: '4.1',
        createdAt: '2026-09-10T12:00:00Z',
        updatedAt: '2026-09-10T12:00:00Z',
        lastOpenedAt: '2026-09-10T12:00:00Z',
        activeSectionId: section.id,
        state: 'READING',
        isLearnMode: false,
        sourceKind,
        source: null,
        syllabus: [],
        userProfile: state.context.profile,
        learningPlan: { ...persistedPlan, generationNotes: 'x'.repeat(4000) },
      },
    });
    expect(generationInput.generationNotes).toBe('x'.repeat(4000));
    const referenceContext = buildLessonGenerationReferenceContext(generationInput);
    // Checks transport of structured values through the internal lesson context boundary.
    expect(referenceContext).toContain(
      JSON.stringify({ controls: { ...controls, reference: 'source' }, languageProficiency })
    );
  });

  test('encodes granularity independently of depth without changing historical notes', () => {
    const depth = 'less' as const;
    const notes = COURSE_CONTROL_POSITIONS.map(granularity =>
      buildCoursePlanningInstructions(
        {
          coursePlanningControls: { depth, granularity },
        },
        false
      )
    );
    expect(new Set(notes).size).toBe(COURSE_CONTROL_POSITIONS.length);
    expect(buildCoursePlanningInstructions({ teachingPreferences: 'Usa esempi.' }, true)).toBe('');
    expect(buildCoursePlanningInstructions(null, false)).toBe('');
  });
});
