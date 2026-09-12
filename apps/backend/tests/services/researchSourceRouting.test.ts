import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  planResearchSources,
  validateResearchSourceRouting,
} from '../../src/services/researchSourceRouting.js';

const decision = {
  suppliedSourcesSufficient: true,
  rationale: 'The supplied academic chapter covers the historical question.',
  channels: [
    { type: 'web', selected: false, rationale: 'No current claims are needed.' },
    { type: 'youtube', selected: false, rationale: 'The textual argument is sufficient.' },
  ],
};

describe('research source routing boundary', () => {
  test.each([
    { ...decision, channels: decision.channels.slice(0, 1) },
    { ...decision, channels: [decision.channels[0], decision.channels[0]] },
    {
      ...decision,
      channels: [...decision.channels, { type: 'social', selected: true, rationale: 'Examples' }],
    },
    {
      ...decision,
      channels: [{ ...decision.channels[0], selected: 'false' }, decision.channels[1]],
    },
    { ...decision, rationale: ' ' },
    { ...decision, suppliedSourcesSufficient: false },
  ])('rejects incomplete or invalid decisions before retrieval', value => {
    expect(() => validateResearchSourceRouting(value, ['web', 'youtube'])).toThrow();
  });

  test('limits selection to available capabilities', () => {
    expect(
      validateResearchSourceRouting({ ...decision, channels: [decision.channels[0]] }, ['web'])
        .channels
    ).toHaveLength(1);
    expect(() => validateResearchSourceRouting(decision, ['web'])).toThrow();
  });

  test('uses the production context slot without retrieval tools', async () => {
    const generateObject = vi.fn().mockResolvedValue(decision);
    const signal = new AbortController().signal;
    const result = await planResearchSources(
      {
        config: getGlobalModelConfig(),
        level: 'lesson',
        topic: 'Freud: dream-work',
        learningContext: 'Explain condensation in its historical setting.',
        sourceContext: 'Academic chapter with definitions and examples.',
        availableChannels: ['web', 'youtube'],
        signal,
      },
      generateObject
    );
    expect(result).toEqual(decision);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'context', webSearch: false, signal })
    );
    expect(generateObject.mock.calls[0][0].tools).toBeUndefined();
  });
});
