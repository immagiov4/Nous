import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  planResearchSources,
  type ResearchSourceRoutingInput,
  validateResearchSourceRouting,
} from '../../src/services/researchSourceRouting.js';
import { getRetryDecision, WorkflowStepError } from '../../src/workflows/retryPolicy.js';

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
    try {
      validateResearchSourceRouting(value, ['web', 'youtube'], 'Supplied chapter');
      throw new Error('Invalid decision was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowStepError);
      if (!(error instanceof WorkflowStepError)) throw error;
      expect(error.failure).toMatchObject({
        kind: 'corrective',
        code: 'research_source_routing_invalid',
        feedback: expect.any(String),
      });
      expect(
        getRetryDecision({ failure: error.failure, attemptNumber: 1, maxAttempts: 3 })
      ).toEqual({ retry: true, delayMs: 0 });
    }
  });

  test('limits selection to available capabilities', () => {
    expect(
      validateResearchSourceRouting(
        { ...decision, channels: [decision.channels[0]] },
        ['web'],
        'Supplied chapter'
      ).channels
    ).toHaveLength(1);
    expect(() => validateResearchSourceRouting(decision, ['web'], 'Supplied chapter')).toThrow();
  });

  test.each([
    '',
    ' \n ',
  ])('rejects source-free sufficiency through the production planner', async sourceContext => {
    const generateObject = vi.fn().mockResolvedValue(decision);
    const input: ResearchSourceRoutingInput = {
      config: getGlobalModelConfig(),
      level: 'course',
      topic: 'Systems',
      learningContext: 'Learn systems',
      sourceContext,
      availableChannels: ['web', 'youtube'],
      signal: new AbortController().signal,
    };
    await expect(planResearchSources(input, generateObject)).rejects.toThrow(
      'Absent supplied material'
    );
    generateObject.mockResolvedValue({
      ...decision,
      suppliedSourcesSufficient: false,
      channels: decision.channels.map(channel => ({
        ...channel,
        selected: channel.type === 'web',
      })),
    });
    await expect(planResearchSources(input, generateObject)).resolves.toMatchObject({
      suppliedSourcesSufficient: false,
    });
  });

  test.each([
    decision,
    {
      ...decision,
      suppliedSourcesSufficient: false,
      channels: decision.channels.map(channel => ({
        ...channel,
        selected: channel.type === 'web',
      })),
    },
  ])('accepts sufficient sources or selected retrieval through the production planner', async modelDecision => {
    const generateObject = vi.fn().mockResolvedValue(modelDecision);
    const signal = new AbortController().signal;
    const input: ResearchSourceRoutingInput = {
      config: getGlobalModelConfig(),
      level: 'lesson',
      topic: 'Freud: dream-work',
      learningContext: 'Explain condensation in its historical setting.',
      sourceContext: 'Academic chapter with definitions and examples.',
      availableChannels: ['web', 'youtube'],
      signal,
    };
    const result = await planResearchSources(input, generateObject);
    expect(result).toEqual(modelDecision);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'context', webSearch: false, signal })
    );
    expect(generateObject.mock.calls[0][0].tools).toBeUndefined();
    generateObject.mockResolvedValue({ ...decision, suppliedSourcesSufficient: false });
    await expect(planResearchSources(input, generateObject)).rejects.toThrow(
      'Insufficient supplied sources require a selected research capability.'
    );
  });
});
