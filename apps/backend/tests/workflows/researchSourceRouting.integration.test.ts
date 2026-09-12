import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { CodexAppServerError } from '../../src/services/codexAppServer.js';
import {
  createCourseResearchNode,
  createCourseResearchServices,
} from '../../src/workflows/courseGenerationResearch.js';
import {
  CourseGenerationWorkflowConfigSchema,
  CoursePreparationStateSchema,
  CourseResearchStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import { createWorkflowRegistry, workflow } from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { retryCorrective } from '../../src/workflows/retryPolicy.js';
import { runWorkflowStepClaim } from '../../src/workflows/workflowStepRunner.js';
import { researchRoutingScenarios } from '../services/researchSourceRouting.scenarios.js';
import {
  claimNextStep,
  createPostgresWorkflowIntegrationContext,
  createStore,
  setupPostgresWorkflowIntegrationContext,
  teardownPostgresWorkflowIntegrationContext,
} from './postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
const scenarios = [
  ...researchRoutingScenarios.map(scenario => ({
    ...scenario,
    failure: null as Error | null,
    suppliedSourcesSufficient: scenario.selected.length === 0,
    expectedStatus: 'completed',
  })),
  ...(['web', 'youtube'] as const).flatMap(channel =>
    [true, false].map(sufficient => ({
      ...researchRoutingScenarios[0],
      name: `${channel} unavailable with supplied sufficiency ${sufficient}`,
      selected: [channel],
      failure: new CodexAppServerError('Provider unavailable', 'process'),
      suppliedSourcesSufficient: sufficient,
      expectedStatus: sufficient ? 'completed' : 'failed',
    }))
  ),
  {
    ...researchRoutingScenarios[0],
    name: 'optional web invalid contract',
    selected: ['web' as const],
    suppliedSourcesSufficient: true,
    expectedStatus: 'failed',
    failure: retryCorrective({
      code: 'invalid',
      message: 'Invalid output',
      feedback: 'Correct the output.',
    }),
  },
];

describe
  .skipIf(!context.enabled)
  .sequential('research selection through persisted workflow execution', () => {
    beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
    afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

    test.each(scenarios)('$name executes only selected retrieval branches', async scenario => {
      const sql = context.sql;
      if (!sql) throw new Error('An isolated integration database is required.');
      const config = { models: getGlobalModelConfig(), maxAttempts: 1, timeoutMs: 60_000 };
      const routing = {
        suppliedSourcesSufficient: scenario.suppliedSourcesSufficient,
        rationale: scenario.learningContext,
        channels: (['web', 'youtube'] as const).map(type => ({
          type,
          selected: scenario.selected.includes(type),
          rationale: `Controlled ${type} decision for ${scenario.name}.`,
        })),
      };
      const generateObject = vi.fn(async (input: { name: string }) => {
        if (input.name === 'research_source_routing') return routing;
        if (input.name === 'course_youtube_queries')
          return { queries: ['binary search pointers', 'binary search visualization'] };
        if (scenario.failure) throw scenario.failure;
        return {
          brief: 'Authoritative researched facts.',
          sources: [{ title: 'Official reference', url: 'https://example.org/reference' }],
        };
      });
      const researchYoutube = vi.fn(async () => {
        if (scenario.failure) throw scenario.failure;
        return {
          context: 'A sorted interval shrinks.',
          discoveredVideoCount: 1,
          rationale: 'Narrated demonstration.',
          videoCandidates: [
            {
              title: 'Binary search demonstration',
              url: 'https://www.youtube.com/watch?v=search-demo',
              segments: [
                {
                  startSeconds: 0,
                  endSeconds: 10,
                  text: 'Compare the midpoint and retain the possible half.',
                },
              ],
            },
          ],
        };
      });
      const services = createCourseResearchServices({
        generateObject: generateObject as never,
        readSourceMaterials: async () => [],
        researchYoutube,
      });
      const registry = createWorkflowRegistry();
      const definition = registry.register({
        current: workflow({
          id: 'research-routing-integration',
          compatibilityId: 'research-routing-integration-v1',
          configSchema: CourseGenerationWorkflowConfigSchema,
          executionDefaults: config,
          inputSchema: CoursePreparationStateSchema,
          outputSchema: CourseResearchStateSchema,
          root: createCourseResearchNode(),
        }),
      }).current;
      const store = createStore(sql);
      const input = CoursePreparationStateSchema.parse({
        context: {
          assessmentSummary: scenario.learningContext,
          language: 'English',
          profile: null,
          sourceNames: [],
          sources: [],
          topic: scenario.topic,
        },
        projectRevision: 0,
        request: { projectId: context.projectId, userId: context.userId, mode: 'learn' },
        stage: 'prepared',
        strategy: 'learn',
      });
      const created = await store.createRun({
        id: randomUUID(),
        userId: context.userId,
        projectId: context.projectId,
        workflowId: definition.id,
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        requestKey: randomUUID(),
        config,
        input,
        materialization: materializeWorkflowStart(definition, input, { resolvedConfig: config }),
      });
      for (let steps = 0; steps < 20; steps += 1) {
        const claim = await claimNextStep(store, definition, 'research-routing-test');
        if (!claim) break;
        const result = await runWorkflowStepClaim({ claim, registry, services, store });
        expect(['checkpointed', 'failure-recorded']).toContain(result.status);
      }
      const state = await store.getRunState({ runId: created.run.id, userId: context.userId });
      expect(state?.run.status).toBe(scenario.expectedStatus);
      const calls = generateObject.mock.calls.map(([call]) => call.name);
      expect(calls.filter(name => name === 'research_source_routing')).toHaveLength(1);
      expect(calls.filter(name => name === 'course_web_research')).toHaveLength(
        scenario.selected.includes('web') ? 1 : 0
      );
      expect(calls.filter(name => name === 'course_youtube_queries')).toHaveLength(
        scenario.selected.includes('youtube') ? 1 : 0
      );
      expect(researchYoutube).toHaveBeenCalledTimes(scenario.selected.includes('youtube') ? 2 : 0);
      expect(state?.nodes.filter(node => node.definitionId === 'research-course-web')).toHaveLength(
        scenario.selected.includes('web') ? 1 : 0
      );
    });
  });
