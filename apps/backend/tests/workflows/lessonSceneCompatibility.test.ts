import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import {
  LegacyLessonVisualContractSchemas,
  toLegacyLessonVisualTypes,
} from '../../src/workflows/lessonGenerationWorkflowSchemas.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';

// Current definitions deployed immediately before lesson scenes (issue #242).
const PRE_SCENE_DEFINITIONS = {
  'lesson-artifact-draft': '392a9122392b550f78f3068082398ae39b6816ad9916fc07dd0c37e3f61d423c',
  'lesson-generation': '96f356e0bbf7874d3ac35bf3358065bbb54de42492593ce061d5ed133dc19ce8',
  'retry-lesson-visual': '14a744b9ef1dd78b5b0e9d6880e932f8466cdace886e5370f9f275e1e1d95d45',
} as const;

describe('lesson scene deployment compatibility', () => {
  const registry = createProductionRegistry();

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
      generatedVisuals: [
        visual('svg', { code: '<svg></svg>', kind: 'svg' }),
        visual('scene', { kind: 'scene', scene: { type: 'checklist' } }),
      ],
      plan: { visualType: 'lesson_scene' },
    });

    expect(legacy.plan.visualType).toBe('structural_svg');
    expect(legacy.generatedVisuals.map(entry => entry.id)).toEqual(['svg']);
    expect(
      z
        .array(LegacyLessonVisualContractSchemas.ProjectLessonVisualSchema)
        .safeParse(legacy.generatedVisuals).success
    ).toBe(true);
  });
});
