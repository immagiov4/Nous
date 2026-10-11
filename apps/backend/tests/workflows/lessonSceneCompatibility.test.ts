import {
  createLessonSceneSchema,
  LESSON_SCENE_REGISTRY,
  type LessonSceneSchema,
} from '@shared/lessonScene';
import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import {
  LegacyLessonVisualContractSchemas,
  toLegacyLessonVisualTypes,
} from '../../src/workflows/lessonGenerationWorkflowSchemas.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { proportionalScene } from '../helpers/animatedLessonScenes.js';

// Current definitions deployed immediately before lesson scenes (issue #242).
const PRE_SCENE_DEFINITIONS = {
  'lesson-artifact-draft': '392a9122392b550f78f3068082398ae39b6816ad9916fc07dd0c37e3f61d423c',
  'lesson-generation': '96f356e0bbf7874d3ac35bf3358065bbb54de42492593ce061d5ed133dc19ce8',
  'retry-lesson-visual': '14a744b9ef1dd78b5b0e9d6880e932f8466cdace886e5370f9f275e1e1d95d45',
} as const;

// Building a production registry takes several seconds; this suite builds two.
const REGISTRY_REBUILD_TIMEOUT_MS = 60_000;

describe('lesson scene deployment compatibility', () => {
  const registry = createProductionRegistry();

  // Captured before the registry refactor; these contracts are already deployed.
  const sceneDefinitions = {
    'lesson-artifact-draft': '956181ac1b4138937550c1c22241e8299f8fc0d37c5610d49ff58c70ba6ba369',
    'lesson-generation': 'b87ce7fd3d524947ec5cf37fc094285bc16b1125e71af250759a70ba536838f2',
    'prepare-lesson-playback-block':
      'ebff02047a4ba00430f7669580767612803303b64ea9ebb3117d9131474b6cf8',
    'retry-lesson-visual': 'c305d51e357e1660acdfb770bea309943844dbc5c1249756307ea366bb48c375',
  };
  test.each(
    Object.entries(sceneDefinitions)
  )('%s keeps its deployed scene hash', (workflowId, hash) => {
    expect(
      registry.listDefinitionDeployments().find(entry => entry.current.workflowId === workflowId)
        ?.current.definitionHash
    ).toBe(hash);
  });

  test(
    'a future form reconstructs every deployed scene workflow from catalog snapshots',
    () => {
      const futureForm = {
        ...LESSON_SCENE_REGISTRY.definition,
        schema: LESSON_SCENE_REGISTRY.definition.schema.extend({
          futureField: z.string(),
        }),
      };
      const extendedSchema = createLessonSceneSchema({
        ...LESSON_SCENE_REGISTRY,
        'future-form': futureForm,
      });
      const parsed = extendedSchema.parse({
        ...proportionalScene,
        type: 'future-form',
        futureField: 'Additional content',
      });
      expect(parsed.futureField?.toUpperCase()).toBe('ADDITIONAL CONTENT');
      expect(extendedSchema.parse(proportionalScene)).toEqual(proportionalScene);
      // This test models a later release whose enum is wider than the current binary's.
      const extended = createProductionRegistry(
        extendedSchema as unknown as typeof LessonSceneSchema
      );
      const nextHashes = Object.fromEntries(
        extended
          .listDefinitionDeployments()
          .map(({ current }) => [current.workflowId, current.definitionHash])
      );
      for (const deployment of registry.listDefinitionDeployments()) {
        for (const boundary of deployment.supportedDefinitions) {
          expect(extended.resolve(boundary.workflowId, boundary.definitionHash)?.manifest).toEqual(
            registry.resolve(boundary.workflowId, boundary.definitionHash)?.manifest
          );
        }
        if (deployment.current.workflowId in sceneDefinitions) {
          expect(nextHashes[deployment.current.workflowId]).not.toBe(
            deployment.current.definitionHash
          );
        }
      }
    },
    REGISTRY_REBUILD_TIMEOUT_MS
  );

  test.each(
    Object.entries(PRE_SCENE_DEFINITIONS)
  )('%s keeps resolving its pre-scene definition', (workflowId, definitionHash) => {
    const deployment = registry
      .listDefinitionDeployments()
      .find(candidate => candidate.current.workflowId === workflowId);
    expect(deployment?.current.definitionHash).not.toBe(definitionHash);
    expect(deployment?.supportedDefinitions).toContainEqual({
      definitionHash,
      definitionHashVersion: 1,
      workflowId,
    });
    expect(registry.resolve(workflowId, definitionHash)).not.toBeNull();
  });

  test('pre-scene runs read completed sections that already contain scene visuals', () => {
    const visual = (id: string, render: unknown) => ({
      createdAt: '2026-10-09T00:00:00.000Z',
      id,
      render,
      slotId: `slot-${id}`,
    });
    const legacy = toLegacyLessonVisualTypes({
      contentBlocks: [
        { slotId: 'slot-svg', type: 'generated-visual', visualId: 'svg' },
        { slotId: 'slot-scene', type: 'generated-visual', visualId: 'scene' },
        { content: 'Testo', type: 'markdown' },
      ],
      generatedVisuals: [
        visual('svg', { code: '<svg></svg>', kind: 'svg' }),
        visual('scene', { kind: 'scene', scene: { type: 'checklist' } }),
      ],
      plan: { visualType: 'lesson_scene' },
    });

    expect(legacy.plan.visualType).toBe('structural_svg');
    expect(legacy.generatedVisuals.map(entry => entry.id)).toEqual(['svg']);
    expect(
      legacy.contentBlocks.map(block => ('slotId' in block ? block.slotId : block.type))
    ).toEqual(['slot-svg', 'markdown']);
    expect(
      z
        .array(LegacyLessonVisualContractSchemas.ProjectLessonVisualSchema)
        .safeParse(legacy.generatedVisuals).success
    ).toBe(true);
  });
});
