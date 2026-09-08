import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  CourseInterviewModelTurnSchema,
  CourseInterviewTurnSchema,
  createCourseInterviewModel,
} from '../../src/workflows/courseInterviewModel.js';

describe('course interview model', () => {
  test('new proposals expose course preferences while persisted legacy turns remain readable', () => {
    const legacy = {
      kind: 'proposal',
      message: 'Ready.',
      proposal: {
        context: 'Student',
        experienceLevel: 'base',
        goals: 'Understand trees',
        language: 'Italiano',
        learningStyle: 'examples',
        topic: 'Trees',
      },
    };
    expect(CourseInterviewTurnSchema.safeParse(legacy).success).toBe(true);
    expect(CourseInterviewModelTurnSchema.safeParse(legacy).success).toBe(false);
    const overridden = {
      ...legacy,
      proposal: {
        ...legacy.proposal,
        language: '日本語',
        teachingPreferences: 'Use worked examples.',
      },
    };
    expect(CourseInterviewModelTurnSchema.parse(overridden)).toEqual(overridden);
    expect(
      CourseInterviewModelTurnSchema.parse({
        ...overridden,
        proposal: { ...overridden.proposal, teachingPreferences: '' },
      })
    ).toMatchObject({ proposal: { teachingPreferences: '' } });
  });
  test('uses the assessment slot and preserves reliable source context', async () => {
    const generateObject = vi.fn().mockResolvedValue({
      kind: 'question',
      message: 'Quale risultato vuoi ottenere?',
    });
    const model = createCourseInterviewModel({ generateObject });

    const result = await model.assessTurn({
      config: getGlobalModelConfig(),
      hasReliableSourceContext: true,
      messages: [{ role: 'user', text: 'Voglio imparare i sistemi distribuiti.' }],
      mode: 'learn',
      signal: new AbortController().signal,
      sourceContext: 'Indice e contenuto verificato della fonte.',
    });

    expect(result).toEqual({ kind: 'question', message: 'Quale risultato vuoi ottenere?' });
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: CourseInterviewModelTurnSchema,
        slot: 'assessment',
      })
    );
    const request = generateObject.mock.calls[0]?.[0];
    expect(request.prompt).toContain('Indice e contenuto verificato della fonte.');
    expect(request.prompt).toContain('Reliable source context: yes');
  });

  test('requires one typed question or proposal', () => {
    expect(
      CourseInterviewTurnSchema.safeParse({ kind: 'question', message: 'Da dove parti?' }).success
    ).toBe(true);
    expect(
      CourseInterviewTurnSchema.safeParse({
        kind: 'proposal',
        message: 'Ho abbastanza informazioni.',
        proposal: {
          context: 'Studente di informatica con basi di reti.',
          experienceLevel: 'Intermediate',
          goals: 'Capire e progettare sistemi distribuiti.',
          language: 'Italiano',
          learningStyle: 'Practical',
          topic: 'Sistemi distribuiti',
        },
      }).success
    ).toBe(true);
    expect(
      CourseInterviewTurnSchema.safeParse({ kind: 'proposal', message: 'Manca.' }).success
    ).toBe(false);
  });
});
