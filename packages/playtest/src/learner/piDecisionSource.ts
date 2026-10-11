import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { Observation } from '../operator/session';
import type { DecisionSource, LearnerDecision } from './loop';
import { createModelResolver } from './modelResolution';

const DECISION_TOOLS = ['act', 'report_friction', 'diary', 'stop'];
const actionSchema = Type.Union([
  Type.Object({ type: Type.Literal('observe') }),
  Type.Object({ type: Type.Literal('click'), ref: Type.String() }),
  Type.Object({ type: Type.Literal('type'), ref: Type.String(), text: Type.String() }),
  Type.Object({ type: Type.Literal('press'), key: Type.String() }),
  Type.Object({
    type: Type.Literal('scroll'),
    direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
  }),
  Type.Object({
    type: Type.Literal('drag'),
    ref: Type.String(),
    dx: Type.Number(),
    dy: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('fill-credential'),
    ref: Type.String(),
    field: Type.Union([Type.Literal('email'), Type.Literal('password')]),
  }),
]);

function visibleObservation(observation: Observation) {
  const { stepIndex, url, nodes } = observation;
  return { stepIndex, url, nodes };
}

/** Pi selects a decision; browser execution and credential resolution belong to the operator. */
export function createPiDecisionSource(options: {
  model: string;
  provider: string;
}): DecisionSource {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const resolveModel = createModelResolver({ ...options, registry: modelRegistry });
  return {
    async decide(input) {
      const model = await resolveModel();
      let decision: LearnerDecision | undefined;
      const accept = async (next: LearnerDecision, ctx: ExtensionContext) => {
        if (decision) throw new Error('A learner decision has already been selected.');
        decision = next;
        // End the SDK turn here: another model turn would bypass the story's step budget.
        ctx.abort();
        return { content: [{ type: 'text' as const, text: 'Recorded' }], details: {} };
      };
      const extension: ExtensionFactory = pi => {
        // Pi's default coding prompt adds environment details even with a prompt override.
        pi.on('before_agent_start', () => ({ systemPrompt: input.systemPrompt }));
        pi.registerTool({
          name: 'act',
          label: 'Act',
          description:
            'Choose one action on the visible viewport and state its expected result. Use observe to look again while an operation progresses; press accepts actual keyboard keys only. Credentials are filled privately by the operator.',
          parameters: Type.Object({ action: actionSchema, expectation: Type.String() }),
          executionMode: 'sequential',
          execute: async (_id, args, _signal, _update, ctx) =>
            accept({ ...args, type: 'act' }, ctx),
        });
        pi.registerTool({
          name: 'report_friction',
          label: 'Report friction',
          description: 'Record friction experienced while using the app.',
          parameters: Type.Object({ text: Type.String() }),
          executionMode: 'sequential',
          execute: async (_id, args, _signal, _update, ctx) =>
            accept({ ...args, type: 'report-friction' }, ctx),
        });
        pi.registerTool({
          name: 'diary',
          label: 'Diary',
          description: 'Record what you have encountered or learned in the app.',
          parameters: Type.Object({ entry: Type.String() }),
          executionMode: 'sequential',
          execute: async (_id, args, _signal, _update, ctx) =>
            accept({ ...args, type: 'diary' }, ctx),
        });
        pi.registerTool({
          name: 'stop',
          label: 'Stop',
          description: 'Stop with a summary, having completed the goal or abandoned it.',
          parameters: Type.Object({
            reason: Type.Union([Type.Literal('completed'), Type.Literal('abandoned')]),
            summary: Type.String(),
          }),
          executionMode: 'sequential',
          execute: async (_id, args, _signal, _update, ctx) =>
            accept({ ...args, type: 'stop' }, ctx),
        });
      };
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: join(tmpdir(), 'playtest-pi-agent'),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
        systemPromptOverride: () => input.systemPrompt,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        authStorage,
        modelRegistry,
        model,
        settingsManager,
        resourceLoader: loader,
        noTools: 'builtin',
        tools: DECISION_TOOLS,
        sessionManager: SessionManager.inMemory(),
        thinkingLevel: 'off',
      });
      try {
        const screenshot = await readFile(input.observation.screenshotPath);
        const history = input.history.map(turn => ({
          decision: turn.decision,
          ...(turn.result
            ? {
                result: {
                  ...turn.result,
                  observation: visibleObservation(turn.result.observation),
                },
              }
            : {}),
        }));
        await session.prompt(
          JSON.stringify({ history, observation: visibleObservation(input.observation) }),
          {
            images: [{ type: 'image', data: screenshot.toString('base64'), mimeType: 'image/png' }],
          }
        );
        if (!decision) throw new Error('Pi returned without a learner decision.');
        return decision;
      } finally {
        session.dispose();
      }
    },
  };
}
