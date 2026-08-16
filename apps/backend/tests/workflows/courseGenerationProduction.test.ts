import { describe, expect, test, vi } from 'vitest';

import { createCoursePlanStrategyStages } from '../../src/workflows/courseGenerationProduction.js';

const strategies = ['learn', 'single-source', 'source-set', 'archive'] as const;

describe('production course planning strategy dispatch', () => {
  test.each(strategies)('keeps the shared draft/refine route for %s', async strategy => {
    const standard = {
      draftCoursePlan: vi.fn(async () => ({ strategy: 'standard' }) as never),
      refineCoursePlan: vi.fn(async () => ({ strategy: 'standard' }) as never),
    };
    const archive = {
      draftCoursePlan: vi.fn(async () => ({ strategy: 'archive' }) as never),
      refineCoursePlan: vi.fn(async () => ({ strategy: 'archive' }) as never),
    };
    const stages = createCoursePlanStrategyStages({ archive, standard });

    await stages.draftCoursePlan({ input: { strategy } } as never);
    await stages.refineCoursePlan({ input: { strategy } } as never);

    const selected = strategy === 'archive' ? archive : standard;
    const bypassed = strategy === 'archive' ? standard : archive;
    expect(selected.draftCoursePlan).toHaveBeenCalledOnce();
    expect(selected.refineCoursePlan).toHaveBeenCalledOnce();
    expect(bypassed.draftCoursePlan).not.toHaveBeenCalled();
    expect(bypassed.refineCoursePlan).not.toHaveBeenCalled();
  });
});
