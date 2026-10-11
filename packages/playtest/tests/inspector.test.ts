import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InspectorFinding, inspect, type StepProbeFinding } from '../src/inspector/inspect';
import { createPiVisualJudge, type VisualJudge } from '../src/inspector/judge';
import type { LearnerRunResult } from '../src/learner/loop';
import { mapOpenRouterModel } from '../src/learner/modelResolution';
import type { Observation } from '../src/operator/session';
import catalogueEntry from './fixtures/models/openrouter-sonnet-4.json';

const sdk = vi.hoisted(() => ({
  find: vi.fn(),
  createSession: vi.fn(),
  prompt: vi.fn(),
  dispose: vi.fn(),
  abort: vi.fn(),
  tool: undefined as ToolDefinition | undefined,
  loaderOptions: undefined as
    | { extensionFactories: ExtensionFactory[]; systemPromptOverride: () => string }
    | undefined,
}));
vi.mock('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: { inMemory: () => ({}) },
  ModelRegistry: { inMemory: () => ({ find: sdk.find }) },
  SettingsManager: { inMemory: (settings: unknown) => settings },
  SessionManager: { inMemory: () => ({}) },
  DefaultResourceLoader: class {
    constructor(options: NonNullable<typeof sdk.loaderOptions>) {
      sdk.loaderOptions = options;
    }
    async reload() {
      for (const extension of sdk.loaderOptions?.extensionFactories ?? []) {
        await extension({
          on: vi.fn(),
          registerTool: (tool: ToolDefinition) => {
            sdk.tool = tool;
          },
        } as unknown as ExtensionAPI);
      }
    }
  },
  createAgentSession: sdk.createSession,
}));

const observations: Observation[] = [
  { stepIndex: 0, url: 'https://example.test', screenshotPath: 'step-0.png', nodes: [] },
  { stepIndex: 3, url: 'https://example.test', screenshotPath: 'step-3.png', nodes: [] },
];
const learner: LearnerRunResult = {
  outcome: 'completed',
  turns: [],
  diary: [],
  friction: [],
  observations,
};
const input = {
  probeFindings: [],
  learner,
  observations,
  styleReference: ['style.png'],
  taxonomy: 'D01: clipping',
};
function finding(overrides: Partial<InspectorFinding> = {}): InspectorFinding {
  return {
    source: 'judge',
    taxonomyClass: 'D01',
    title: 'Clipped text',
    trigger: 'Open the page',
    expected: 'Readable text',
    actual: 'Text is cut off',
    stepIndex: 0,
    screenshotPath: 'step-0.png',
    ...overrides,
  };
}

describe('inspector', () => {
  it('preserves probe evidence, threshold and recorded step', async () => {
    const probe: StepProbeFinding = {
      stepIndex: 0,
      screenshotPath: 'step-0.png',
      signal: {
        kind: 'clipped-text',
        selector: '#label',
        text: 'Label',
        scrollWidth: 120,
        clientWidth: 80,
      },
      threshold: 10,
      taxonomyClass: 'D01',
    };
    const [result] = await inspect({ ...input, probeFindings: [probe] });
    expect(result).toMatchObject({
      ...probe,
      source: 'probe',
      taxonomyClass: 'D01',
      stepIndex: 0,
      screenshotPath: 'step-0.png',
    });
    expect(JSON.parse(result.actual)).toEqual(probe.signal);
    expect(result.expected).toBe('Maintainer threshold: 10');
  });

  it('pairs each screenshot with compact visible names without node metadata or learner history', async () => {
    const judge = vi.fn(async () => [finding()]);
    const screens = observations.map((screen, index) => ({
      ...screen,
      nodes: (index === 0
        ? ['Small visible text', '', 'Small visible text', ' ']
        : ['Next screen']
      ).map(name => ({
        name,
        ref: 'private-ref',
        role: 'text',
        box: { x: 0, y: 0, w: 10, h: 10 },
      })),
    }));
    expect(
      await inspect({
        ...input,
        observations: screens,
        learner: { ...learner, diary: ['Private history'] },
        judge: { judge },
      })
    ).toEqual([finding()]);
    expect(judge).toHaveBeenCalledExactlyOnceWith({
      screenshots: [
        { screenshotPath: 'step-0.png', visibleText: ['Small visible text'] },
        { screenshotPath: 'step-3.png', visibleText: ['Next screen'] },
      ],
      styleReference: input.styleReference,
      taxonomy: input.taxonomy,
    });
  });

  it('drops and counts missing or fabricated screenshot evidence', async () => {
    const { stepIndex: _step, ...missingStep } = finding();
    const { screenshotPath: _path, ...missingPath } = finding();
    const judge: VisualJudge = {
      judge: async () =>
        [
          missingStep,
          missingPath,
          finding({ stepIndex: 9 }),
          finding({ screenshotPath: 'unseen.png' }),
          finding({ stepIndex: 0.5 }),
          finding({ source: 'probe' }),
          finding(),
        ] as InspectorFinding[],
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await inspect({ ...input, judge })).toEqual([finding()]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'Inspector dropped 6 judge findings with invalid screenshot evidence or fields.'
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('sorts by observation step and taxonomy, preserving ties', async () => {
    const later = finding({ stepIndex: 1, screenshotPath: 'step-3.png', taxonomyClass: 'D02' });
    const earlierClass = finding({
      stepIndex: 1,
      screenshotPath: 'step-3.png',
      taxonomyClass: 'D01',
    });
    const tie = { ...earlierClass, title: 'Second finding' };
    const judge = { judge: async () => [later, earlierClass, finding(), tie] };
    expect(await inspect({ ...input, judge })).toEqual([
      finding(),
      { ...earlierClass, stepIndex: 3 },
      { ...tie, stepIndex: 3 },
      { ...later, stepIndex: 3 },
    ]);
  });

  it('returns no findings for an empty trace and supplied probe list', async () => {
    expect(await inspect({ ...input, observations: [] })).toEqual([]);
  });
});

describe('Pi visual judge with a mocked SDK', () => {
  let runDir: string;
  let screenshots: string[];
  let styleReference: string[];
  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'inspector-test-'));
    screenshots = [join(runDir, 'step-0.png'), join(runDir, 'step-1.png')];
    styleReference = [join(runDir, 'reference.jpg')];
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<main>First screen</main>');
      await page.screenshot({ path: screenshots[0] });
      await page.setContent('<main>Second screen</main>');
      await page.screenshot({ path: screenshots[1] });
      await page.screenshot({ path: styleReference[0], type: 'jpeg' });
    } finally {
      await browser.close();
    }
  });
  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.tool = undefined;
    sdk.find.mockReturnValue(mapOpenRouterModel(catalogueEntry));
    sdk.createSession.mockResolvedValue({ session: { prompt: sdk.prompt, dispose: sdk.dispose } });
    sdk.prompt.mockImplementation(async () => {
      if (!sdk.tool) throw new Error('No judge tool registered');
      await sdk.tool.execute('test-call', { findings: [] }, undefined, undefined, {
        abort: sdk.abort,
      } as unknown as ExtensionContext);
    });
  });
  const options = { provider: 'openrouter', model: catalogueEntry.id };
  const judgeInput = () => ({
    screenshots: screenshots.map((screenshotPath, index) => ({
      screenshotPath,
      visibleText: [index === 0 ? 'First screen' : 'Second screen'],
    })),
    styleReference,
    taxonomy: 'D01: clipping',
  });

  it('resolves shared model metadata and sends ordered real images through an isolated session', async () => {
    const judge = createPiVisualJudge(options);
    expect(await judge.judge(judgeInput())).toEqual([]);
    expect(sdk.find).toHaveBeenCalledExactlyOnceWith(options.provider, options.model);
    expect(sdk.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mapOpenRouterModel(catalogueEntry),
        noTools: 'builtin',
        tools: ['submit_findings'],
      })
    );
    expect(sdk.loaderOptions).toMatchObject({
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    const [prompt, imageInput] = sdk.prompt.mock.calls[0];
    expect(JSON.parse(prompt)).toEqual({
      screenshots: judgeInput().screenshots.map((screen, stepIndex) => ({ stepIndex, ...screen })),
      styleReference,
      taxonomy: 'D01: clipping',
      imageOrder: 'Screenshots in list order, then style references in list order.',
    });
    expect(imageInput.images).toEqual(
      await Promise.all(
        [...screenshots, ...styleReference].map(async (path, index) => ({
          type: 'image',
          data: (await readFile(path)).toString('base64'),
          mimeType: index < screenshots.length ? 'image/png' : 'image/jpeg',
        }))
      )
    );
    expect(sdk.abort).toHaveBeenCalledTimes(1);
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
    await judge.judge(judgeInput());
    expect(sdk.find).toHaveBeenCalledTimes(1);
  });

  it('returns submitted findings and leaves missing evidence for inspector validation', async () => {
    const candidate = finding({ screenshotPath: screenshots[0] });
    const { stepIndex: _index, ...missingStep } = candidate;
    sdk.prompt.mockImplementation(async () => {
      await sdk.tool?.execute(
        'test-call',
        { findings: [candidate, missingStep] },
        undefined,
        undefined,
        { abort: sdk.abort } as unknown as ExtensionContext
      );
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const judge = createPiVisualJudge(options);
      const actualObservations = screenshots.map((screenshotPath, stepIndex) => ({
        ...observations[0],
        stepIndex,
        screenshotPath,
      }));
      expect(
        await inspect({ ...input, observations: actualObservations, judge, styleReference })
      ).toEqual([candidate]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('skips model execution when there are no observed screens', async () => {
    expect(await createPiVisualJudge(options).judge({ ...judgeInput(), screenshots: [] })).toEqual(
      []
    );
    expect(sdk.find).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it('rejects text-only models before starting a visual session', async () => {
    sdk.find.mockReturnValue({ ...mapOpenRouterModel(catalogueEntry), input: ['text'] });
    await expect(createPiVisualJudge(options).judge(judgeInput())).rejects.toThrow(
      'image-capable model'
    );
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it('disposes the session when Pi returns without submitting findings', async () => {
    sdk.prompt.mockResolvedValue(undefined);
    await expect(createPiVisualJudge(options).judge(judgeInput())).rejects.toThrow(
      'without visual findings'
    );
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the session when screenshot loading or model execution fails', async () => {
    await expect(
      createPiVisualJudge(options).judge({
        ...judgeInput(),
        screenshots: [{ screenshotPath: join(runDir, 'missing.png'), visibleText: [] }],
      })
    ).rejects.toThrow();
    expect(sdk.prompt).toHaveBeenCalledTimes(0);
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
    sdk.prompt.mockRejectedValue(new Error('Model failed'));
    await expect(createPiVisualJudge(options).judge(judgeInput())).rejects.toThrow('Model failed');
    expect(sdk.dispose).toHaveBeenCalledTimes(2);
  });
});
