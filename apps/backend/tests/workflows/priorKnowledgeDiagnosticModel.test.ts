import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { CodexTurnInput } from '../../src/services/codexAppServer.js';
import { isRecord } from '../../src/utils/validation.js';
import { createCourseObjectGenerator } from '../../src/workflows/courseGenerationModel.js';
import { createPriorKnowledgeDiagnosticModel } from '../../src/workflows/priorKnowledgeDiagnosticModel.js';
import { acceptDiagnosticSubmission } from '../../src/workflows/priorKnowledgeDiagnosticState.js';

const profile = {
  context: 'A neighborhood bookstore',
  experienceLevel: 'Unverified',
  goals: 'Plan a local book event',
  language: 'English',
  learningStyle: 'Examples',
  topic: 'Bookstore marketing',
};
const recordedAt = '2026-09-11T12:00:00Z';
const tree = {
  title: 'Your starting point',
  topics: ['Readers', 'Events', 'Promotion', 'Budget'].map(title => ({
    title,
    scope: `Plan ${title.toLowerCase()} for a local book event`,
    children: [
      { title: `${title} details`, scope: `Explain ${title.toLowerCase()}`, children: [] },
    ],
  })),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function createScenario(provider: 'codex' | 'openrouter') {
  let nextOutput: unknown;
  let nextOutputValid = true;
  const requests: Record<string, unknown>[] = [];
  const respond = (schema: Record<string, unknown>, prompt: string) => {
    const request = JSON.parse(prompt);
    const output = request.collection ? nextOutput : tree;
    const response =
      isRecord(schema.properties) && 'result' in schema.properties ? { result: output } : output;
    expect(z.fromJSONSchema(schema).safeParse(response).success).toBe(
      request.collection ? nextOutputValid : true
    );
    if (request.collection) {
      // Gemini's structured-output subset represents string literals with enum.
      const supportedSchema = JSON.parse(
        JSON.stringify(schema, (key, value) => (key === 'const' ? undefined : value))
      );
      expect(
        z
          .fromJSONSchema(supportedSchema)
          .safeParse({ result: { ...(output as object), kind: 'diagnostic' } }).success
      ).toBe(false);
    }
    requests.push(request);
    return response;
  };
  const runCodexObject = vi.fn(async (input: CodexTurnInput) => {
    assert(input.outputSchema);
    const prompt = input.input[0];
    assert(prompt.type === 'text');
    return JSON.stringify(respond(input.outputSchema, prompt.text));
  });
  const fetchRequest = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
    const body = JSON.parse(String(options?.body));
    const format = body.response_format.json_schema;
    expect(format.strict).toBe(true);
    const content = respond(format.schema, body.messages.at(-1).content);
    return Response.json({
      id: 'synthetic-response',
      model: body.model,
      created: 0,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(content) },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-test-key');
  vi.stubGlobal('fetch', fetchRequest);
  const generateObject =
    provider === 'codex'
      ? createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject })
      : createCourseObjectGenerator();
  const model = createPriorKnowledgeDiagnosticModel({ generateObject, now: () => recordedAt });
  const input = {
    config: {
      ...getGlobalModelConfig(),
      aiProvider: provider,
      aiProviderOverrides: { assessment: provider },
    },
    profile,
    signal: new AbortController().signal,
    projectId: 'synthetic-course',
    runId: 'synthetic-run',
    outputId: 'tree',
    providerAttemptRef: 'synthetic:tree',
    messages: [],
    hasReliableSourceContext: false,
  };
  return {
    model,
    input,
    requests,
    setOutput: (output: unknown, valid = true) => {
      nextOutput = output;
      nextOutputValid = valid;
    },
  };
}

async function submitSelfAssessment(scenario: ReturnType<typeof createScenario>) {
  const collection = await scenario.model.start(scenario.input);
  const uncertainIds = collection.nodes
    .filter(node => node.parentNodeId === null)
    .slice(0, 3)
    .map(node => node.nodeId);
  const answers = collection.nodes.map(node => ({
    itemId: node.nodeId,
    response: uncertainIds.includes(node.nodeId)
      ? { kind: 'self-report' as const, value: 'uncertain' as const }
      : { kind: 'not-submitted' as const },
  }));
  const submitted = acceptDiagnosticSubmission(
    collection,
    {
      collectionId: collection.collectionId,
      stageId: 'tree',
      requestId: 'synthetic-self-assessment',
      answers,
    },
    recordedAt
  );
  return { submitted, uncertainIds, answers };
}

describe.each([
  'codex',
  'openrouter',
] as const)('%s diagnostic structured-output boundary', provider => {
  test.each([
    'round',
    'complete',
  ] as const)('accepts %s after three uncertain topics and all other topics omitted', async kind => {
    const scenario = createScenario(provider);
    const { submitted, uncertainIds, answers } = await submitSelfAssessment(scenario);
    const evaluation = {
      interpretations: [],
      conflicts: [],
      missingInformation: [
        {
          nodeIds: uncertainIds,
          question: 'How would you promote the event?',
          reason: 'Uncertainty is not evidence of performance.',
        },
      ],
    };
    scenario.setOutput(
      kind === 'round'
        ? {
            kind,
            title: 'Plan an event',
            evaluation,
            tasks: ['text', 'choice'].map(format => ({
              nodeIds: uncertainIds,
              claim: { statement: 'Choose an event audience', scope: 'One local event' },
              criteria: ['Relate the audience to the event'],
              learnerPrompt: 'Who would you invite and why?',
              responseFormatDefinition:
                format === 'text'
                  ? { format }
                  : {
                      format,
                      options: [
                        { id: 'readers', text: 'Local readers' },
                        { id: 'everyone', text: 'Everyone' },
                      ],
                    },
              selectionReason: 'Clarify the starting point',
            })),
          }
        : {
            kind,
            title: 'Your starting point',
            feedback: 'Begin by identifying the audience for an event.',
            reason: 'No further adequate task changes the starting point.',
            unresolvedLimitations: ['Performance remains unobserved.'],
            evaluation,
          }
    );

    const advanced = await scenario.model.advance({
      ...scenario.input,
      outputId: 'next-pass',
      providerAttemptRef: 'synthetic:advance',
      collection: submitted,
    });

    expect(advanced.passes.at(-1)?.stage.kind).toBe(kind);
    expect(advanced.passes[0].submission?.answers).toEqual(answers);
    expect(advanced.passes[0].attempts).toEqual([]);
    expect(advanced.evaluations.at(-1)?.evaluation).toEqual(evaluation);
    expect(scenario.requests).toHaveLength(2);
    expect(scenario.requests[1]).toMatchObject({
      collection: { passes: submitted.passes, nodes: submitted.nodes },
    });
    if (kind === 'round') {
      expect(
        advanced.passes.at(-1)?.tasks.map(task => task.responseFormatDefinition.format)
      ).toEqual(['text', 'choice']);
      expect(advanced.collectionEnd).toBeUndefined();
    } else {
      expect(advanced.collectionEnd?.unresolvedLimitations).toEqual([
        'Performance remains unobserved.',
      ]);
    }
  });

  test.each([
    { name: 'unknown stage kind', change: { kind: 'diagnostic' } },
    {
      name: 'omitted evaluation list',
      change: { evaluation: { interpretations: [], missingInformation: [] } },
    },
    {
      name: 'null required evaluation list',
      change: { evaluation: { interpretations: null, missingInformation: [], conflicts: [] } },
    },
  ])('keeps $name corrective on every attempt and retains the accepted answers', async ({
    change,
  }) => {
    const scenario = createScenario(provider);
    const { submitted, answers } = await submitSelfAssessment(scenario);
    const retained = structuredClone(submitted);
    scenario.setOutput(
      {
        kind: 'complete',
        title: 'Your starting point',
        feedback: 'Begin with planning an event.',
        reason: 'No further adequate task changes the starting point.',
        unresolvedLimitations: [],
        evaluation: { interpretations: [], missingInformation: [], conflicts: [] },
        ...change,
      },
      false
    );

    for (const attempt of [1, 2, 3]) {
      await expect(
        scenario.model.advance({
          ...scenario.input,
          outputId: 'next-pass',
          providerAttemptRef: `synthetic:advance:${attempt}`,
          collection: submitted,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          failure: expect.objectContaining({
            code: 'course_model_output_invalid',
            kind: 'corrective',
          }),
        })
      );
    }
    expect(submitted).toEqual(retained);
    expect(submitted.passes[0].submission?.answers).toEqual(answers);
    expect(scenario.requests).toHaveLength(4);
  });

  test('rejects invented self-report interpretations instead of recording performance evidence', async () => {
    const scenario = createScenario(provider);
    const { submitted } = await submitSelfAssessment(scenario);
    scenario.setOutput({
      kind: 'complete',
      title: 'Your starting point',
      feedback: 'Begin with planning an event.',
      reason: 'No further adequate task changes the starting point.',
      unresolvedLimitations: [],
      evaluation: {
        interpretations: [
          {
            attemptId: 'initial-assessment',
            criterionId: 'uncertainty-confirmation',
            observation: 'Uncertain self-report',
            assessment: 'Unable to self-assess',
            limitations: [],
          },
        ],
        missingInformation: [],
        conflicts: [],
      },
    });
    await expect(
      scenario.model.advance({ ...scenario.input, outputId: 'next-pass', collection: submitted })
    ).rejects.toThrow(
      'The diagnostic interpretation does not identify submitted criterion evidence.'
    );
    expect(submitted.evaluations).toEqual([]);
    expect(submitted.passes).toHaveLength(1);
  });
});
