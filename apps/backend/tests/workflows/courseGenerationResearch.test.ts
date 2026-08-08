import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { YouTubeResearchOutcome } from '../../src/services/youtubeResearch.js';
import { CourseModelProviderError } from '../../src/workflows/courseGenerationModel.js';
import { createCourseResearchServices } from '../../src/workflows/courseGenerationResearch.js';
import {
  type CourseGenerationWorkflowConfig,
  type CourseGenerationWorkflowServices,
  createCourseGenerationWorkflow,
} from '../../src/workflows/courseGenerationWorkflow.js';
import type {
  CoursePreparationState,
  CourseResearchState,
  CourseWebResearch,
  CourseYoutubeQueryInput,
  CourseYoutubeResearch,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import { retryCorrective } from '../../src/workflows/retryPolicy.js';
import type {
  FanOutDefinition,
  FanOutResult,
  StepDefinition,
  WorkflowNode,
} from '../../src/workflows/types.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const config: CourseGenerationWorkflowConfig = {
  maxAttempts: 3,
  models: getGlobalModelConfig(),
  timeoutMs: 600_000,
};

const prepared: CoursePreparationState = {
  context: {
    assessmentSummary: 'USER: Voglio capire i sistemi distribuiti.',
    language: 'Italiano',
    profile: {
      context: 'Studente di informatica',
      experienceLevel: 'base',
      goals: 'Capire i fondamenti',
      language: 'Italiano',
      learningStyle: 'esempi',
      topic: 'Sistemi distribuiti',
    },
    sourceNames: [],
    sources: [],
    topic: 'Sistemi distribuiti',
  },
  projectRevision: 2,
  request: { mode: 'learn', projectId: 'project-1', userId: 'user-1' },
  stage: 'prepared',
  strategy: 'learn',
};

const stageContext = <Input>(input: Input, attemptNumber = 1) => ({
  attemptNumber,
  config,
  execution: { nodeInstanceId: 'research', runId: 'run-1' },
  idempotencyKey: 'research-key',
  input,
  retryFeedback: '',
  signal: new AbortController().signal,
});

const findNode = (id: string): WorkflowNode => {
  const definition = createCourseGenerationWorkflow(config);
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

const runStep = <Input, Output>(
  id: string,
  input: Input,
  services: CourseGenerationWorkflowServices,
  attemptNumber = 1
): Promise<Output> => {
  const node = findNode(id);
  if (node.kind !== 'step') throw new Error(`${id} is not a step.`);
  return (
    node as StepDefinition<
      Input,
      Output,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >
  ).run({ ...stageContext(input, attemptNumber), services });
};

const fanIn = <ParentInput, ItemInput, ItemOutput, Output>(
  id: string,
  results: readonly FanOutResult<ItemInput, ItemOutput>[],
  parentInput: ParentInput
): Output => {
  const node = findNode(id);
  if (node.kind !== 'fanOut') throw new Error(`${id} is not a fan-out.`);
  return (
    node as FanOutDefinition<
      ParentInput,
      ItemInput,
      ItemOutput,
      Output,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >
  ).fanIn(results, parentInput);
};

const workflowServices = (
  services: ReturnType<typeof createCourseResearchServices>
): CourseGenerationWorkflowServices => services as CourseGenerationWorkflowServices;

const youtubeOutcome = (title: string, url: string, text: string): YouTubeResearchOutcome => ({
  context: `RAW_QUERY_CONTEXT_${text}`,
  discoveredVideoCount: 1,
  rationale: 'Transcript disponibile.',
  videoCandidates: [
    {
      segments: [{ endSeconds: 20, startSeconds: 10, text }],
      title,
      url,
    },
  ],
});

type YoutubeCollection = {
  failures: Array<{ retryAfterMs?: number }>;
  outcomes: YouTubeResearchOutcome[];
  state: CoursePreparationState;
};

type ResearchBranchInput = {
  branch: 'web' | 'youtube';
  state: CoursePreparationState;
};

type ResearchBranchOutput =
  | { branch: 'web'; research: CourseWebResearch }
  | { branch: 'youtube'; research: CourseYoutubeResearch };

const collectYoutube = (
  results: readonly FanOutResult<CourseYoutubeQueryInput, YouTubeResearchOutcome>[]
): YoutubeCollection =>
  fanIn('research-course-youtube-queries', results, {
    queries: results.map(result => result.input.query),
    state: prepared,
  });

const finalizeYoutube = (
  collection: YoutubeCollection,
  services: CourseGenerationWorkflowServices
): Promise<ResearchBranchOutput> =>
  runStep('finalize-course-youtube-research', collection, services);

describe('course generation research', () => {
  test('keeps the web and YouTube provider calls atomic without changing their prompts', async () => {
    let webPrompt = '';
    const generateObject = vi.fn(async (input: { name: string; prompt: string }) => {
      if (input.name === 'course_youtube_queries') {
        return { queries: ['distributed systems fundamentals', 'distributed systems course'] };
      }
      webPrompt = input.prompt;
      return {
        brief: 'Brief fattuale.',
        sources: [
          {
            note: 'Definizioni autorevoli',
            title: 'Designing Data-Intensive Applications',
            url: 'https://example.com/ddia',
          },
        ],
      };
    });
    const researchYoutube = vi.fn(async (query: string) =>
      youtubeOutcome(
        'Distributed Systems',
        `https://www.youtube.com/watch?v=${encodeURIComponent(query)}`,
        'Messaggi e nodi.'
      )
    );
    const services = createCourseResearchServices({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      researchYoutube,
    });

    const web = await services.researchCourseWeb(stageContext(prepared));
    const plan = await services.planCourseYoutubeQueries(stageContext(prepared));
    const video = await services.researchCourseYoutubeQuery(
      stageContext({ language: 'Italiano', query: plan.queries[0] ?? '', queryIndex: 0 })
    );

    expect(web).toMatchObject({ brief: 'Brief fattuale.' });
    expect(plan.queries).toHaveLength(2);
    expect(video.videoCandidates[0]).toMatchObject({ title: 'Distributed Systems' });
    expect(webPrompt).toContain('Ricerca fonti autorevoli e recenti.');
    expect(researchYoutube).toHaveBeenCalledWith(
      'distributed systems fundamentals',
      'Italiano',
      expect.any(AbortSignal)
    );
  });

  test('bounds and stably orders source text sent to web research', async () => {
    let webPrompt = '';
    const services = createCourseResearchServices({
      generateObject: vi.fn(async (input: { prompt: string }) => {
        webPrompt = input.prompt;
        return { brief: 'Brief.', sources: [] };
      }) as never,
      readSourceMaterials: vi.fn().mockResolvedValue([
        {
          descriptor: {
            hash: 'a'.repeat(64),
            id: 'source-1',
            kind: 'text',
            mimeType: 'text/plain',
            name: 'z-source.txt',
          },
          text: `${'x'.repeat(8_000)}OMITTED_REGION${'x'.repeat(22_000)}SOURCE_TAIL`,
        },
        {
          descriptor: {
            hash: 'b'.repeat(64),
            id: 'source-2',
            kind: 'text',
            mimeType: 'text/plain',
            name: 'a-source.txt',
          },
          text: 'SECOND_SOURCE_VISIBLE',
        },
      ]),
    });

    await services.researchCourseWeb(
      stageContext({
        ...prepared,
        request: { ...prepared.request, mode: 'document' },
        strategy: 'single-source',
      })
    );

    expect(webPrompt).not.toContain('OMITTED_REGION');
    expect(webPrompt).toContain('SOURCE_TAIL');
    expect(webPrompt.length).toBeLessThan(30_000);
    expect(webPrompt).toContain('SECOND_SOURCE_VISIBLE');
    expect(webPrompt.indexOf('a-source.txt')).toBeLessThan(webPrompt.indexOf('z-source.txt'));
  });

  test('declares fail-fast research branches and ordered collect-mode query work', () => {
    const gather = findNode('gather-course-research');
    const queries = findNode('research-course-youtube-queries');
    if (gather.kind !== 'fanOut' || queries.kind !== 'fanOut') {
      throw new Error('Course research composition is incomplete.');
    }
    const gatherFanOut = gather as FanOutDefinition<CoursePreparationState, ResearchBranchInput>;
    const queryFanOut = queries as FanOutDefinition<
      { queries: string[]; state: CoursePreparationState },
      CourseYoutubeQueryInput
    >;
    const branches = gatherFanOut.inputs(prepared);
    const queryInputs = queryFanOut.inputs({
      queries: ['first query', 'second query'],
      state: prepared,
    });

    expect(gatherFanOut.failureMode).toBe('fail-fast');
    expect(branches.map(input => gatherFanOut.keyBy(input))).toEqual(['web', 'youtube']);
    expect(queryFanOut.failureMode).toBe('collect');
    expect(queryInputs.map(input => queryFanOut.keyBy(input))).toEqual(['0', '1']);
  });

  test('deduplicates exact query values in stable order before fan-out', async () => {
    const generateObject = vi.fn().mockResolvedValue({
      queries: ['distributed systems', 'consensus tutorial', 'distributed systems'],
    });
    const services = createCourseResearchServices({
      generateObject,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      researchYoutube: vi.fn(),
    });
    const queries = findNode('research-course-youtube-queries');
    if (queries.kind !== 'fanOut') {
      throw new Error('Course YouTube query fan-out is missing.');
    }
    const queryFanOut = queries as FanOutDefinition<
      { queries: string[]; state: CoursePreparationState },
      CourseYoutubeQueryInput
    >;

    const plan = await services.planCourseYoutubeQueries(stageContext(prepared));
    const queryInputs = queryFanOut.inputs({ ...plan, state: prepared });

    expect(plan.queries).toEqual(['distributed systems', 'consensus tutorial']);
    expect(queryInputs.map(input => input.query)).toEqual([
      'distributed systems',
      'consensus tutorial',
    ]);
    expect(queryInputs).toHaveLength(2);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  test('keeps successful YouTube evidence when another query fails', async () => {
    const successful = youtubeOutcome(
      'Successful video',
      'https://www.youtube.com/watch?v=success',
      'Risultato valido.'
    );
    const input = (query: string, queryIndex: number): CourseYoutubeQueryInput => ({
      language: 'Italiano',
      query,
      queryIndex,
    });
    const collection = collectYoutube([
      { input: input('successful query', 0), key: '0', output: successful, status: 'completed' },
      {
        failure: { code: 'course_research_failed', kind: 'operational', message: 'failed' },
        input: input('failed query', 1),
        key: '1',
        status: 'failed',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await finalizeYoutube(collection, {} as CourseGenerationWorkflowServices);

    expect(result).toMatchObject({
      branch: 'youtube',
      research: { candidates: [{ title: 'Successful video' }], status: 'completed' },
    });
    expect(result.research.context).toContain('Risultato valido.');
    const researchState = fanIn<
      CoursePreparationState,
      ResearchBranchInput,
      ResearchBranchOutput,
      CourseResearchState
    >(
      'gather-course-research',
      [
        {
          input: { branch: 'web', state: prepared },
          key: 'web',
          output: { branch: 'web', research: { brief: 'Brief.', sources: [] } },
          status: 'completed',
        },
        {
          input: { branch: 'youtube', state: prepared },
          key: 'youtube',
          output: result,
          status: 'completed',
        },
      ],
      prepared
    );
    expect(researchState).toMatchObject({
      research: { youtube: result.research },
      stage: 'research',
    });
    expect(warn).toHaveBeenCalledWith(
      '[Workflow] Course YouTube research unavailable.',
      expect.objectContaining({ failedQueryCount: 1 })
    );
    warn.mockRestore();
  });

  test('deduplicates query evidence under one aggregate transcript budget', async () => {
    const markers = ['FIRST_TRANSCRIPT', 'SECOND_TRANSCRIPT', 'THIRD_TRANSCRIPT'];
    const results = markers.map((marker, queryIndex) => {
      const input: CourseYoutubeQueryInput = {
        language: 'Italiano',
        query: `query ${queryIndex}`,
        queryIndex,
      };
      return {
        input,
        key: String(queryIndex),
        output: youtubeOutcome(
          `Video ${queryIndex + 1}`,
          `https://www.youtube.com/watch?v=video-${queryIndex + 1}`,
          `${marker}${'x'.repeat(120_000)}`
        ),
        status: 'completed' as const,
      };
    });

    const result = await finalizeYoutube(
      collectYoutube(results),
      {} as CourseGenerationWorkflowServices
    );

    expect(result.research.context).not.toContain('RAW_QUERY_CONTEXT_');
    expect(result.research.context).toContain('FIRST_TRANSCRIPT');
    expect(result.research.context).toContain('SECOND_TRANSCRIPT');
    expect(result.research.context).not.toContain('THIRD_TRANSCRIPT');
    expect(result.research.candidates).toHaveLength(2);
  });

  test('preserves Retry-After when every YouTube query is rate limited', async () => {
    const services = createCourseResearchServices({
      generateObject: vi.fn(),
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      researchYoutube: vi.fn().mockRejectedValue({
        responseHeaders: { 'retry-after': '23' },
      }),
    });
    const input: CourseYoutubeQueryInput = {
      language: 'Italiano',
      query: 'first query',
      queryIndex: 0,
    };
    const queryFailure = await runStep<CourseYoutubeQueryInput, YouTubeResearchOutcome>(
      'research-course-youtube-query',
      input,
      workflowServices(services)
    ).catch(error => error);
    const collection = collectYoutube([
      {
        failure: queryFailure.failure,
        input,
        key: '0',
        status: 'failed',
      },
    ]);

    const finalFailure = await finalizeYoutube(collection, workflowServices(services)).catch(
      error => error
    );

    expect(queryFailure).toMatchObject({ failure: { retryAfterMs: 23_000 } });
    expect(finalFailure).toMatchObject({
      failure: { code: 'course_research_failed', retryAfterMs: 23_000 },
    });
  });

  test.each([
    [
      'invalid structured output',
      retryCorrective({
        code: 'course_model_output_invalid',
        feedback: 'Return valid JSON matching the requested schema.',
        message: 'The course model returned invalid structured output.',
      }),
    ],
    ['provider failure', new CourseModelProviderError(new Error('provider unavailable'))],
  ])('uses the deterministic topic fallback after final %s', async (_name, failure) => {
    const fallbackState: CoursePreparationState = {
      ...prepared,
      context: { ...prepared.context, topic: `  ${'x'.repeat(120)}  ` },
    };
    const generateObject = vi.fn(async () => {
      throw failure;
    });
    const services = createCourseResearchServices({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      researchYoutube: vi.fn(),
    });

    await expect(
      runStep<ResearchBranchInput, { queries: string[]; state: CoursePreparationState }>(
        'plan-course-youtube-queries',
        { branch: 'youtube', state: fallbackState },
        workflowServices(services),
        config.maxAttempts - 1
      )
    ).rejects.toBeTruthy();

    const fallbackPlan = await runStep<
      ResearchBranchInput,
      { queries: string[]; state: CoursePreparationState }
    >(
      'plan-course-youtube-queries',
      { branch: 'youtube', state: fallbackState },
      workflowServices(services),
      config.maxAttempts
    );
    const plannerStep = findNode('plan-course-youtube-queries');

    expect(fallbackPlan).toEqual(
      expect.objectContaining({ queries: ['x'.repeat(100)], state: fallbackState })
    );
    expect(plannerStep.outputSchema.parse(fallbackPlan)).toEqual(fallbackPlan);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
