import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type DecisionSource,
  type LearnerDecision,
  type LearnerInput,
  runLearner,
} from '../src/learner/loop';
import { createModelResolver, mapOpenRouterModel } from '../src/learner/modelResolution';
import { createPiDecisionSource } from '../src/learner/piDecisionSource';
import { ACTING_RULES, buildLearnerPrompt } from '../src/learner/prompt';
import { createScriptedDecisionSource } from '../src/learner/scriptedDecisionSource';
import { type OperatorSession, openOperatorSession } from '../src/operator/session';
import type { Story } from '../src/types';
import tieredEntry from './fixtures/models/openrouter-sonnet-4.json';

const catalogueEntry = { ...tieredEntry, pricing: { ...tieredEntry.pricing, overrides: [] } };
const sdk = vi.hoisted(() => ({ find: vi.fn(), createSession: vi.fn() }));
vi.mock('@mariozechner/pi-coding-agent', async importOriginal => ({
  ...(await importOriginal<typeof import('@mariozechner/pi-coding-agent')>()),
  ModelRegistry: { inMemory: () => ({ find: sdk.find }) },
  createAgentSession: sdk.createSession,
}));

describe('learner model resolution', () => {
  it('rejects a text-only learner model before opening a Pi session or reading the screenshot', async () => {
    sdk.find.mockReturnValue({ ...mapOpenRouterModel(catalogueEntry), input: ['text'] });
    const source = createPiDecisionSource({ provider: 'openrouter', model: catalogueEntry.id });
    await expect(source.decide({ systemPrompt: '', history: [], observation })).rejects.toThrow(
      'image-capable model'
    );
    expect(sdk.createSession).not.toHaveBeenCalled();
  });
  it('retains catalogue pricing tiers for per-request accounting', () => {
    expect(mapOpenRouterModel(tieredEntry).pricingOverrides).toEqual(tieredEntry.pricing.overrides);
  });
  it('maps a recorded catalogue entry to Pi units and capabilities', () => {
    expect(mapOpenRouterModel(catalogueEntry)).toEqual({
      id: 'anthropic/claude-sonnet-4',
      name: 'Anthropic: Claude Sonnet 4',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true,
      input: ['image', 'text'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
      pricingOverrides: [],
    });
  });

  it('uses the registry first without fetching the catalogue', async () => {
    const model = mapOpenRouterModel(catalogueEntry);
    const find = vi.fn(() => model);
    const fetchCatalogue = vi.fn(async () => ({ data: [] }));
    const resolve = createModelResolver({
      provider: 'openrouter',
      model: model.id,
      registry: { find },
      fetchCatalogue,
    });
    expect(await resolve()).toBe(model);
    expect(find).toHaveBeenCalledWith('openrouter', model.id);
    expect(fetchCatalogue).toHaveBeenCalledTimes(0);
  });

  it('loads current catalogue tiers for an OpenRouter registry model with only flat rates', async () => {
    const { pricingOverrides: _overrides, ...registered } = mapOpenRouterModel(catalogueEntry);
    const fetchCatalogue = vi.fn(async () => ({ data: [tieredEntry] }));
    const resolve = createModelResolver({
      provider: 'openrouter',
      model: tieredEntry.id,
      registry: { find: () => registered },
      fetchCatalogue,
    });
    expect(await resolve()).toMatchObject({ pricingOverrides: tieredEntry.pricing.overrides });
    expect(fetchCatalogue).toHaveBeenCalledOnce();
  });

  it('shares a single cached resolution across concurrent and later calls', async () => {
    const find = vi.fn(() => undefined);
    const fetchCatalogue = vi.fn(async () => ({ data: [catalogueEntry] }));
    const resolve = createModelResolver({
      provider: 'openrouter',
      model: catalogueEntry.id,
      registry: { find },
      fetchCatalogue,
    });
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(second).toBe(first);
    expect(await resolve()).toBe(first);
    expect(find).toHaveBeenCalledTimes(1);
    expect(fetchCatalogue).toHaveBeenCalledTimes(1);
  });

  it.each([
    'other-provider',
    'openrouter',
  ])('names provider and model when %s cannot resolve it', async provider => {
    const fetchCatalogue = vi.fn(async () => ({ data: [catalogueEntry] }));
    const resolve = createModelResolver({
      provider,
      model: 'unknown-model',
      registry: { find: () => undefined },
      fetchCatalogue,
    });
    await expect(resolve()).rejects.toThrow(`Unknown Pi model: ${provider}/unknown-model`);
    expect(fetchCatalogue).toHaveBeenCalledTimes(provider === 'openrouter' ? 1 : 0);
  });

  it('rejects missing catalogue limits instead of inventing a token budget', () => {
    expect(() =>
      mapOpenRouterModel({ ...catalogueEntry, top_provider: { max_completion_tokens: null } })
    ).toThrow();
  });

  it('fetches the public catalogue without authentication, using a mocked response', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [catalogueEntry] }));
    try {
      const resolve = createModelResolver({
        provider: 'openrouter',
        model: catalogueEntry.id,
        registry: { find: () => undefined },
      });
      expect((await resolve()).id).toBe(catalogueEntry.id);
      expect(fetch).toHaveBeenCalledExactlyOnceWith('https://openrouter.ai/api/v1/models');
    } finally {
      fetch.mockRestore();
    }
  });

  it('represents absent optional cache tariffs as zero', () => {
    const model = mapOpenRouterModel({
      ...catalogueEntry,
      pricing: { prompt: '0.000003', completion: '0.000015' },
    });
    expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
  });

  it('retains a failed catalogue resolution rather than fetching again', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }));
    try {
      const resolve = createModelResolver({
        provider: 'openrouter',
        model: catalogueEntry.id,
        registry: { find: () => undefined },
      });
      await expect(resolve()).rejects.toThrow('OpenRouter catalogue request failed: HTTP 503');
      await expect(resolve()).rejects.toThrow('OpenRouter catalogue request failed: HTTP 503');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });
});

const story: Story = {
  id: 'metadata-sentinel',
  kind: 'check',
  title: 'title-sentinel',
  viewports: ['desktop'],
  requires: { credential: 'credential-sentinel' },
  tags: ['tag-sentinel'],
  budget: { steps: 4 },
  body: 'story-sentinel',
  sourcePath: 'path-sentinel',
};
const stop: LearnerDecision = { type: 'stop', reason: 'completed', summary: 'Done' };
const observation = {
  stepIndex: 0,
  url: 'https://example.test',
  screenshotPath: 'screen.png',
  nodes: [],
};
function operator(): OperatorSession {
  return {
    observe: vi.fn(async () => observation),
    act: vi.fn(async () => ({
      status: 'ok' as const,
      observation: { ...observation, stepIndex: 1 },
    })),
    signals: vi.fn(async () => []),
    close: vi.fn(async () => ({ tracePath: 'trace.zip' })),
  };
}
function run(
  source: DecisionSource,
  session = operator(),
  shouldStop = (): string | undefined => undefined
) {
  return runLearner({
    story,
    appDescription: 'app-sentinel',
    operator: session,
    source,
    shouldStop,
  });
}

describe('learner loop', () => {
  it('withholds page URLs from current and historical learner inputs while retaining operator evidence', async () => {
    const decide = vi.fn(
      async (input: LearnerInput): Promise<LearnerDecision> =>
        input.history.length
          ? stop
          : { type: 'act', action: { type: 'observe' }, expectation: 'Read again' }
    );
    const result = await run({ decide });
    expect(result.outcome).toBe('completed');
    expect(decide).toHaveBeenCalledTimes(2);
    for (const [input] of decide.mock.calls) {
      expect(input.observation).not.toHaveProperty('url');
      for (const turn of input.history) expect(turn.result?.observation).not.toHaveProperty('url');
      expect(JSON.stringify(input)).not.toContain(observation.url);
    }
    expect(decide.mock.calls[1][0].history[0].result?.observation.stepIndex).toBe(1);
    expect(result.observations.map(view => view.url)).toEqual([observation.url, observation.url]);
    expect(result.turns[0].result?.observation.url).toBe(observation.url);
    expect(observation.url).toBe('https://example.test');
  });
  it('retains the diary, friction and observations when a later model decision fails', async () => {
    const scripted = createScriptedDecisionSource([
      { type: 'diary', entry: 'Read the page' },
      { type: 'report-friction', text: 'Confusing question' },
      { type: 'act', action: { type: 'observe' }, expectation: 'Read again' },
    ]);
    const result = await run(scripted);
    expect(result).toMatchObject({
      outcome: 'operator-failure',
      reason: 'The learner could not obtain its next decision.',
      diary: ['Read the page'],
      friction: ['Confusing question'],
    });
    expect(result.turns).toHaveLength(3);
    expect(result.observations).toHaveLength(2);
  });
  it('composes only the app, optional persona, story bodies and shared acting rules', () => {
    const persona = {
      id: 'persona-id-sentinel',
      body: 'persona-sentinel',
      sourcePath: 'persona-path-sentinel',
    };
    expect(buildLearnerPrompt({ appDescription: 'app-sentinel', story, persona })).toBe(
      ['app-sentinel', 'persona-sentinel', 'story-sentinel', ACTING_RULES].join('\n\n')
    );
    expect(buildLearnerPrompt({ appDescription: 'app-sentinel', story })).toBe(
      ['app-sentinel', 'story-sentinel', ACTING_RULES].join('\n\n')
    );
  });

  it('ends a source that never stops at the decision budget', async () => {
    const decide = vi.fn(
      async (): Promise<LearnerDecision> => ({ type: 'diary', entry: 'Still reading' })
    );
    const result = await run({ decide });
    expect(result.outcome).toBe('harness-limit');
    expect(result.turns).toHaveLength(story.budget.steps);
    expect(decide).toHaveBeenCalledTimes(story.budget.steps);
  });

  it('records diary, friction and abandonment without acting', async () => {
    const session = operator();
    const result = await run(
      createScriptedDecisionSource([
        { type: 'diary', entry: 'I read the page' },
        { type: 'report-friction', text: 'Confusing' },
        { type: 'stop', reason: 'abandoned', summary: 'Leaving' },
      ]),
      session
    );
    expect(result).toMatchObject({
      outcome: 'abandoned',
      diary: ['I read the page'],
      friction: ['Confusing'],
    });
    expect(session.act).toHaveBeenCalledTimes(0);
  });

  it('stops on an app error before asking for a decision', async () => {
    const source = { decide: vi.fn(async () => stop) };
    expect((await run(source, operator(), () => 'Backend error')).outcome).toBe('app-error');
    expect(source.decide).toHaveBeenCalledTimes(0);
  });

  it('checks app errors again after a pending decision, before acting', async () => {
    let failed = false;
    const session = operator();
    const result = await run(
      {
        async decide() {
          failed = true;
          return { type: 'act', action: { type: 'press', key: 'Enter' }, expectation: 'Open' };
        },
      },
      session,
      () => (failed ? 'Backend error' : undefined)
    );
    expect(result.outcome).toBe('app-error');
    expect(session.act).toHaveBeenCalledTimes(0);
  });

  it('retains stale-reference results and supplies the new observation and history', async () => {
    const session = operator();
    const result = {
      status: 'stale-reference' as const,
      observation: { ...observation, stepIndex: 1 },
      detail: 'Gone',
    };
    session.act = vi.fn(async () => result);
    const source = createScriptedDecisionSource([
      { type: 'act', action: { type: 'click', ref: 'old' }, expectation: 'Open' },
      stop,
    ]);
    const decide = vi.spyOn(source, 'decide');
    const runResult = await run(source, session);
    expect(runResult.turns[0].result).toEqual(result);
    const visible = {
      stepIndex: 1,
      screenshotPath: observation.screenshotPath,
      nodes: observation.nodes,
    };
    expect(decide.mock.calls[1][0]).toMatchObject({
      history: [
        { decision: runResult.turns[0].decision, result: { ...result, observation: visible } },
      ],
      observation: visible,
    });
    expect(runResult.observations).toEqual([observation, result.observation]);
  });

  it('returns operator-failure with accumulated evidence when an operator call throws', async () => {
    const session = operator();
    session.act = vi.fn(async () => {
      throw new Error('Browser closed');
    });
    const result = await run(
      createScriptedDecisionSource([
        { type: 'act', action: { type: 'press', key: 'Enter' }, expectation: 'Open' },
      ]),
      session
    );
    expect(result.outcome).toBe('operator-failure');
    expect(result.turns).toHaveLength(1);
    expect(result.observations).toEqual([observation]);
  });

  it('fails explicitly when the script is exhausted', async () => {
    await expect(
      createScriptedDecisionSource([]).decide({ systemPrompt: '', history: [], observation })
    ).rejects.toThrow('exhausted');
  });
});

describe('learner with the headless operator', () => {
  let browser: Browser;
  let runDir: string;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    runDir = await mkdtemp(join(tmpdir(), 'playtest-learner-'));
  });
  afterAll(async () => {
    await browser?.close();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });
  it('executes a scripted click then stop and returns completed with two turns', async () => {
    const session = await openOperatorSession({
      browser,
      locale: 'it-IT',
      baseUrl: 'about:blank',
      viewport: 'desktop',
      credentials: { email: 'private@example.test', password: 'private-password' },
      runDir,
    });
    try {
      const page = browser.contexts()[0].pages()[0];
      await page.setContent('<button onclick="this.textContent=\'Opened\'">Open</button>');
      const source = createScriptedDecisionSource([
        input => ({
          type: 'act',
          action: { type: 'click', ref: input.observation.nodes[0].ref },
          expectation: 'Open',
        }),
        stop,
      ]);
      const result = await run(source, session);
      expect(result.outcome).toBe('completed');
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].result?.status).toBe('ok');
      expect(result.observations[1].nodes.map(node => node.name)).toContain('Opened');
    } finally {
      await session.close();
    }
  });
});
