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

// Every definition each scene workflow resolved before the registry refactor (#261). Stored runs
// may reference any of them, so the catalog snapshots must keep rebuilding all of them.
const DEPLOYED_SCENE_DEFINITIONS: Readonly<Record<string, readonly string[]>> = {
  'lesson-artifact-draft': [
    '392a9122392b550f78f3068082398ae39b6816ad9916fc07dd0c37e3f61d423c',
    '7bf5d06a27ef067f3c37c5f8090ca7679eeb60c4c7dbedebc2d3319731c68a09',
    '7c2d40e122739f31312717df7c34be8cac1f3711418fdbba0cc5ba9d505d54fb',
    '90dd5cdd41e700497f955d646def7d05d0621ad9267641e65f06138329b3460b',
    '956181ac1b4138937550c1c22241e8299f8fc0d37c5610d49ff58c70ba6ba369',
    'c0218f152cf826053268c1d12b613c0cbd250034f27448a63129aa1422f116af',
  ],
  'lesson-generation': [
    '358796024b1bcf409a8aa7fecf0b291fdaa2ed8238bb9c50271ec5587277d092',
    '3f0002141d9bc3a673f2d592a15608bdd64866c40f7a83e3ad5208a4c08b238a',
    '6292d426839791f56c4850799d265ad727aaf374c3989f84269ed2e53ef539dc',
    '71f3e1783106cc4e7d7e792a9439c7745f6f09fb16fb80c76f9bc74e0940cd66',
    '7ed46edd6ab7ee09440eebae86079ccb13e0709f44c162a57a5c169b05ecdee2',
    '96f356e0bbf7874d3ac35bf3358065bbb54de42492593ce061d5ed133dc19ce8',
    '9a75fcddc0ff92d1c9097236b733709ccdd4157b9e481485fc5e358798697f47',
    'b87ce7fd3d524947ec5cf37fc094285bc16b1125e71af250759a70ba536838f2',
    'c2a9a7589283bec039060d545903c65ab90465400e0319ed803a749275541024',
    'c9d21983b2c81796f5b235129cc854faab285ce6b1e076320875d116b91a1954',
    'ec69547055bd7c687c7d6cec929bb6e6395ed5ec5957674a7c52dcd1a718c378',
  ],
  'prepare-lesson-playback-block': [
    '77f6ece76e8c6bd62943fe850c4dd3f64e89ba0e82e233136710c6141679a92f',
    'ebff02047a4ba00430f7669580767612803303b64ea9ebb3117d9131474b6cf8',
  ],
  'retry-lesson-visual': [
    '14a744b9ef1dd78b5b0e9d6880e932f8466cdace886e5370f9f275e1e1d95d45',
    '8c881f659c71aad3636ed4204411fb073e1bbc8481320cc7ef7e0e11f1995552',
    '98eb3a784fb810d8ed9790df0f48e1878949eba37f85ead42fa83d063dddb681',
    'c305d51e357e1660acdfb770bea309943844dbc5c1249756307ea366bb48c375',
    'd98044ebbdf547412f9f92bb823028974802a89f2f0a81c48f6028ac5c47818e',
    'e427c58809d1a2b3118ace1ec31591ac6ef36912b8814f7ff8c0e2121f780661',
  ],
};

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

  test.each(
    Object.entries(DEPLOYED_SCENE_DEFINITIONS)
  )('%s still resolves every deployed definition', (workflowId, hashes) => {
    const deployment = registry
      .listDefinitionDeployments()
      .find(candidate => candidate.current.workflowId === workflowId);
    expect(deployment?.supportedDefinitions.map(boundary => boundary.definitionHash)).toEqual(
      expect.arrayContaining([...hashes])
    );
    for (const definitionHash of hashes) {
      expect(registry.resolve(workflowId, definitionHash)).toBeDefined();
    }
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
