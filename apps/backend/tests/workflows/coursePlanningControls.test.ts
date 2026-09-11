import {
  COURSE_CONTROL_POSITIONS,
  CoursePlanningControlsSchema,
  DEFAULT_COURSE_PLANNING_CONTROLS,
  resolveCoursePlanningControls,
} from '@shared/coursePlanningControls';
import {
  buildCoursePlanningInstructions,
  resolveCoursePlanningTreatment,
} from '@shared/coursePlanningInstructions';
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

const expectedDepthTreatments = {
  'much-less': 'minimal',
  less: 'reduced',
  auto: 'reference',
  more: 'expanded',
  'much-more': 'extensive',
};
const expectedLessonGroupings = {
  'much-less': 'smallest-coherent-steps',
  less: 'smaller-steps',
  auto: 'reference',
  more: 'broader-results',
  'much-more': 'broadest-coherent-results',
};

function readCourseChoices(context: string) {
  const block = context.split('COURSE CHOICES FROM THE INTERFACE:\n')[1];
  return JSON.parse(block.split('\n')[0]);
}

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
    expect(readCourseChoices(referenceContext)).toMatchObject({
      controls: { ...controls, reference: 'source' },
      languageProficiency,
      treatment: {
        depth: { enrichment: expectedDepthTreatments[depth] },
        granularity: { grouping: 'reference' },
      },
    });
  });

  test.each(
    COURSE_CONTROL_POSITIONS.flatMap(depth =>
      COURSE_CONTROL_POSITIONS.map(granularity => ({ depth, granularity }))
    )
  )('resolves depth $depth and granularity $granularity independently', ({
    depth,
    granularity,
  }) => {
    const controls = { depth, granularity };
    const treatment = resolveCoursePlanningTreatment(controls);
    expect(treatment).toMatchObject({
      depth: { enrichment: expectedDepthTreatments[depth] },
      granularity: { grouping: expectedLessonGroupings[granularity] },
    });
    for (const hasSource of [false, true]) {
      const choices = readCourseChoices(
        buildCoursePlanningInstructions({ coursePlanningControls: controls }, hasSource)
      );
      expect(choices).toEqual({
        controls: { ...controls, reference: hasSource ? 'source' : 'balanced' },
        treatment,
      });
    }
  });

  test('does not manufacture controls from a language declaration or historical notes', () => {
    const languageProficiency = { language: 'Italiano', level: 'B2' as const };
    expect(
      readCourseChoices(buildCoursePlanningInstructions({ languageProficiency }, true))
    ).toEqual({
      languageProficiency,
    });
    expect(buildCoursePlanningInstructions({ teachingPreferences: 'Usa esempi.' }, true)).toBe('');
    expect(buildCoursePlanningInstructions(null, false)).toBe('');
  });
});
