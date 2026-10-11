import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlaytestAdapter } from '../src/adapter';
import { main } from '../src/cli';
import type { InspectorFinding } from '../src/inspector/inspect';
import type { VisualJudge } from '../src/inspector/judge';
import { ACTING_RULES } from '../src/learner/prompt';
import { createScriptedDecisionSource } from '../src/learner/scriptedDecisionSource';
import { writeStoryReports } from '../src/report/writeReports';
import { runPlaytest } from '../src/runner';
import type { Story } from '../src/types';

const judge = vi.hoisted(() =>
  vi.fn(async (_input: Parameters<VisualJudge['judge']>[0]) => [] as InspectorFinding[])
);
vi.mock('../src/inspector/judge', () => ({ createPiVisualJudge: () => ({ judge }) }));
let server: Server;
let baseUrl: string;
let runDir: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/error') {
      response.writeHead(500, { 'x-request-id': 'fixture-request' });
      response.end('Unavailable');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<main><span style="display:inline-block;width:20px;white-space:nowrap;overflow:hidden">A long visible label</span><button onclick="console.error('action fact');this.after(Object.assign(document.createElement('span'),{textContent:'Changed'}))">Change</button><a href="/error">Fail</a></main>`
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
});
afterEach(async () => {
  if (runDir) await rm(runDir, { recursive: true, force: true });
  judge.mockReset();
  judge.mockResolvedValue([]);
  vi.unstubAllEnvs();
});

function story(id: string, requires: Story['requires'] = {}): Story {
  return {
    id,
    kind: 'check',
    title: id,
    viewports: ['desktop'],
    requires,
    tags: [],
    budget: { steps: 3 },
    body: 'Explore.',
    sourcePath: `${id}.md`,
  };
}
function adapter(): PlaytestAdapter {
  return {
    appDescription: () => 'An app to explore.',
    baseUrl: () => baseUrl,
    ensureStack: async () => {},
    prepare: async story => {
      if (story.requires.missing) throw new Error('Fixture is missing');
      return { credentials: { email: 'learner@example.test', password: 'secret' } };
    },
    classify: event =>
      event.kind === 'response' && event.status === 500
        ? {
            stop: true,
            reason: 'Application unavailable',
            correlationId: event.headers['x-request-id'],
          }
        : { stop: false },
    styleReference: () => [],
    taxonomy: () => 'D01 clipping',
    thresholds: () => ({}),
  };
}
async function run(
  stories: Story[],
  app = adapter(),
  sourceFactory = () =>
    createScriptedDecisionSource([{ type: 'stop', reason: 'completed', summary: 'Done' }])
) {
  runDir = await mkdtemp(join(tmpdir(), 'playtest-runner-'));
  return runPlaytest({
    adapter: app,
    stories,
    personas: new Map(),
    concurrency: 2,
    headed: false,
    model: 'fake',
    provider: 'fake',
    runDir,
    sourceFactory,
  });
}
async function report(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('parallel runner', () => {
  it('passes the sampled affect unwrapped when the generic adapter has no description hook', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'playtest-neutral-affect-'));
    const prompts: string[] = [];
    const affects = ['curious', 'tired'];
    const app = adapter();
    const mission = { ...story('affect'), persona: 'learner' };
    const summary = await runPlaytest({
      adapter: app,
      stories: [mission],
      personas: new Map([
        ['learner', { id: 'learner', body: 'Learner profile.', affects, sourcePath: 'learner.md' }],
      ]),
      concurrency: 1,
      headed: false,
      model: 'fake',
      provider: 'fake',
      runDir,
      sourceFactory: () => ({
        async decide(input) {
          prompts.push(input.systemPrompt);
          return input.history.length
            ? { type: 'stop', reason: 'completed', summary: 'Done' }
            : { type: 'diary', entry: 'Observed' };
        },
      }),
    });
    const affect = summary.records[0].affect;
    expect(affects).toContain(affect);
    const expectedPrompt = [
      app.appDescription(),
      `Learner profile.\n\n${affect}`,
      mission.body,
      ACTING_RULES,
    ].join('\n\n');
    expect(prompts).toEqual([expectedPrompt, expectedPrompt]);
    expect((await report(summary.records[0].reportPath)).affect).toBe(affect);
  });
  it.each([
    'completed',
    'operator-failure',
    'app-error',
  ] as const)('cleans up the prepared account after the browser closes for %s', async outcome => {
    const app = adapter();
    const cleanup = vi.fn(async () => {
      expect(
        (await readFile(join(runDir, 'story-0-cleanup', 'desktop', 'trace.zip'))).length
      ).toBeGreaterThan(0);
    });
    app.prepare = async () => ({
      credentials: { email: 'learner@example.test', password: 'secret' },
      cleanup,
    });
    if (outcome === 'app-error') app.baseUrl = () => `${baseUrl}/error`;
    const summary = await run([story('cleanup')], app, () => ({
      decide: async () => {
        if (outcome === 'operator-failure') throw new Error('Synthetic model failure');
        return { type: 'stop', reason: 'completed', summary: 'Done' };
      },
    }));
    expect(summary.records[0].outcome).toBe(outcome);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await report(summary.records[0].reportPath)).tracePath).toBeDefined();
  });

  it('retains partial learner evidence for inspection and reporting after a model failure', async () => {
    const summary = await run([story('partial')], adapter(), () =>
      createScriptedDecisionSource([
        { type: 'diary', entry: 'Observed the page' },
        { type: 'report-friction', text: 'Unclear question' },
      ])
    );
    const data = await report(summary.records[0].reportPath);
    expect(data.outcome).toBe('operator-failure');
    expect(data.learner.diary).toEqual(['Observed the page']);
    expect(data.friction).toEqual(['Unclear question']);
    expect(judge.mock.calls[0][0].trace?.learner).toEqual(data.learner);
    expect(judge.mock.calls[0][0].trace?.probeSignals).toEqual(data.probeSignals);
    expect(judge.mock.calls[0][0].trace?.elapsedMs).toBeGreaterThan(0);
  });
  it('retains cleanup failures alongside an application stop', async () => {
    const app = adapter();
    app.baseUrl = () => `${baseUrl}/error`;
    app.prepare = async () => ({
      credentials: { email: 'learner@example.test', password: 'secret' },
      cleanup: async () => {
        throw new Error('Synthetic cleanup failure');
      },
    });
    const summary = await run([story('cleanup-failure')], app);
    const data = await report(summary.records[0].reportPath);
    expect(data.outcome).toBe('app-error');
    expect(data.cleanupError).toBe('The adapter could not clean up the synthetic story account.');
    expect(await readFile(data.reportPath.replace(/\.json$/, '.md'), 'utf8')).toContain('Cleanup:');
  });

  it('renders untrusted report text as literal Markdown without remote images or links', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'playtest-markdown-'));
    const injected =
      '![image](https://attacker.invalid/image) [link](https://attacker.invalid)\n# Fake heading\n<script>bad</script>';
    await writeStoryReports({
      record: {
        storyId: injected,
        viewport: 'desktop',
        outcome: 'completed',
        reason: injected,
        correlationId: injected,
        findings: [],
        friction: [injected],
        reportPath: join(runDir, 'story.json'),
      },
    });
    const markdown = await readFile(join(runDir, 'story.md'), 'utf8');
    const rendered = renderToStaticMarkup(createElement(ReactMarkdown, null, markdown));
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('<a href="https://attacker.invalid');
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('![image](https://attacker.invalid/image)');
  });
  it('writes isolated story×viewport reports, traces and stable summary counts', async () => {
    const app = adapter();
    const prepare = app.prepare;
    let started = 0;
    let release: () => void = () => {};
    const parallel = new Promise<void>(resolve => {
      release = resolve;
    });
    app.prepare = async (...args) => {
      if (++started === 2) release();
      await parallel;
      return prepare(...args);
    };
    const summary = await run(
      [{ ...story('first'), viewports: ['desktop', 'mobile'] }, story('second')],
      app
    );
    expect(
      summary.records.map(record => [record.storyId, record.viewport, record.outcome])
    ).toEqual([
      ['first', 'desktop', 'completed'],
      ['first', 'mobile', 'completed'],
      ['second', 'desktop', 'completed'],
    ]);
    expect(summary.outcomeCounts.completed).toBe(3);
    expect(Object.values(summary.outcomeCounts).reduce((sum, count) => sum + count, 0)).toBe(3);
    for (const record of summary.records) {
      const data = await report(record.reportPath);
      expect(data.elapsedMs).toBeGreaterThan(0);
      expect(data.elapsedMs).toBe(record.elapsedMs);
      expect(data.modelUsage.total).toMatchObject({
        responses: 0,
        totalTokens: 0,
        cost: { total: 0 },
      });
      expect(data.learner.observations).toHaveLength(1);
      expect(data.probeSignals.length).toBeGreaterThan(0);
      expect(data.findings).toEqual([]);
      expect((await readFile(data.tracePath)).length).toBeGreaterThan(0);
      expect(await readFile(record.reportPath.replace(/\.json$/, '.md'), 'utf8')).toContain(
        'completed'
      );
    }
    expect(await report(join(runDir, 'summary.json'))).toEqual(summary);
    expect(await readFile(join(runDir, 'summary.html'), 'utf8')).toContain('story.md');
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it('isolates a missing precondition from a completing sibling', async () => {
    const summary = await run([story('blocked', { missing: true }), story('sibling')]);
    expect(summary.records.map(record => record.outcome)).toEqual([
      'blocked-precondition',
      'completed',
    ]);
    expect(summary.records[0].reason).toBe('Fixture is missing');
    expect((await report(summary.records[0].reportPath)).outcome).toBe('blocked-precondition');
    expect(summary.outcomeCounts['blocked-precondition']).toBe(1);
    expect(summary.outcomeCounts.completed).toBe(1);
  });

  it('stops on a mid-story 500 with request id, URL and screenshot while a sibling completes', async () => {
    const summary = await run(
      [{ ...story('failure'), body: 'Explore failure.' }, story('sibling')],
      adapter(),
      () => ({
        async decide(input) {
          if (input.systemPrompt.includes('failure')) {
            const node = input.observation.nodes.find(node => node.name === 'Fail');
            if (!node) throw new Error('Missing fixture link');
            return {
              type: 'act',
              action: { type: 'click', ref: node.ref },
              expectation: 'Open link',
            };
          }
          return { type: 'stop', reason: 'completed', summary: 'Done' };
        },
      })
    );
    expect(summary.records.map(record => record.outcome)).toEqual(['app-error', 'completed']);
    expect(summary.records[0].correlationId).toBe('fixture-request');
    const data = await report(summary.records[0].reportPath);
    expect(data.stopEvent.url).toBe(`${baseUrl}/error`);
    expect(data.learner.turns).toHaveLength(1);
    expect(data.learner.observations.at(-1).url).toBe(`${baseUrl}/error`);
    expect(
      (await readFile(data.learner.observations.at(-1).screenshotPath)).length
    ).toBeGreaterThan(0);
    expect(summary.outcomeCounts['app-error']).toBe(1);
    expect(summary.outcomeCounts.completed).toBe(1);
  });

  it('drains raw facts per observation and separates evidenced probe, judge and friction reports', async () => {
    judge.mockImplementation(async ({ screenshots }) => [
      {
        source: 'judge',
        taxonomyClass: 'D01',
        title: '<script>Unreadable</script>',
        trigger: 'Open the page',
        expected: 'Readable',
        actual: 'Clipped',
        stepIndex: 0,
        screenshotPath: screenshots[0].screenshotPath,
      },
    ]);
    const app = adapter();
    app.thresholds = () => ({ clippedTextMinOverflowPx: 0 });
    const summary = await run([story('provenance')], app, () =>
      createScriptedDecisionSource([
        input => {
          const node = input.observation.nodes.find(node => node.name === 'Change');
          if (!node) throw new Error('Missing fixture button');
          return { type: 'act', action: { type: 'click', ref: node.ref }, expectation: 'Change' };
        },
        { type: 'report-friction', text: 'I struggled to read this.' },
        { type: 'stop', reason: 'completed', summary: 'Done' },
      ])
    );
    const data = await report(summary.records[0].reportPath);
    expect(
      data.probeSignals.some(
        (fact: { stepIndex: number; signal: { kind: string } }) =>
          fact.stepIndex === 1 && fact.signal.kind === 'console-error'
      )
    ).toBe(true);
    expect(data.findings.length).toBeGreaterThan(0);
    for (const finding of data.findings) {
      const observation = data.learner.observations.find(
        (observation: { stepIndex: number }) => observation.stepIndex === finding.stepIndex
      );
      expect(finding.screenshotPath).toBe(observation.screenshotPath);
      expect(finding.stepIndex).toBeGreaterThanOrEqual(0);
    }
    expect(data.friction).toEqual(['I struggled to read this.']);
    expect(data.probeFindings).toEqual(
      data.findings.filter((finding: InspectorFinding) => finding.source === 'probe')
    );
    expect(data.judgeFindings).toHaveLength(1);
    const html = await readFile(join(runDir, 'summary.html'), 'utf8');
    expect(html).toContain('&lt;script&gt;Unreadable&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('writes blocked reports for every story when the stack is unavailable', async () => {
    const app = adapter();
    app.ensureStack = async () => {
      throw new Error('Stack is unavailable');
    };
    app.prepare = vi.fn(app.prepare);
    const summary = await run([story('first'), story('second')], app);
    expect(summary.outcomeCounts['blocked-precondition']).toBe(2);
    expect(app.prepare).not.toHaveBeenCalled();
    for (const record of summary.records) {
      expect((await report(record.reportPath)).reason).toBe('Stack is unavailable');
    }
  });

  it('retains reports and raw probe evidence when visual inspection fails', async () => {
    judge.mockRejectedValue(new Error('Judge unavailable'));
    const app = adapter();
    app.thresholds = () => ({ clippedTextMinOverflowPx: 0 });
    const summary = await run([story('inspection')], app);
    const data = await report(summary.records[0].reportPath);
    expect(data.outcome).toBe('completed');
    expect(data.inspectionError).toContain('Visual inspection failed');
    expect(data.probeFindings.length).toBeGreaterThan(0);
    expect(data.probeSignals.length).toBeGreaterThan(0);
  });

  it('writes a harness-limit report when the learner never stops', async () => {
    const summary = await run([story('budget')], adapter(), () => ({
      decide: async () => ({ type: 'diary', entry: 'Thinking' }),
    }));
    const data = await report(summary.records[0].reportPath);
    expect(data.outcome).toBe('harness-limit');
    expect(data.learner.turns).toHaveLength(3);
    expect(data.learner.diary).toEqual(['Thinking', 'Thinking', 'Thinking']);
  });
});

describe('CLI', () => {
  it('fails clearly for unset data root and missing default adapter', async () => {
    vi.stubEnv('NOUS_E2E_DATA', '');
    await expect(main([])).rejects.toThrow('NOUS_E2E_DATA is unset');
    runDir = await mkdtemp(join(tmpdir(), 'playtest-cli-missing-'));
    const child = promisify(execFile)('bun', ['run', resolve('packages/playtest/src/cli.ts')], {
      cwd: runDir,
      env: { ...process.env, NOUS_E2E_DATA: runDir },
      windowsHide: true,
    });
    const failure = await child.catch(error => error as { code: number; stderr: string });
    expect('code' in failure && failure.code).toBe(1);
    const stderr = failure.stderr;
    expect(stderr).toContain('Adapter module is missing:');
    expect(stderr).toContain('e2e');
    expect(stderr).toContain('adapter.ts');
  });

  it('loads a fake adapter, combines filters and writes under the data-root timestamp directory', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'playtest-cli-'));
    vi.stubEnv('NOUS_E2E_DATA', runDir);
    const adapterPath = join(runDir, 'adapter.ts');
    await writeFile(
      adapterPath,
      `export default {
      appDescription: () => 'An app.', baseUrl: () => 'http://localhost',
      ensureStack: async () => { throw new Error('Fixture stack unavailable'); },
      prepare: async () => { throw new Error('Preparation must not run'); },
      classify: () => ({ stop: false }), styleReference: () => [], taxonomy: () => '', thresholds: () => ({})
    };`
    );
    await mkdir(join(runDir, 'stories'));
    await mkdir(join(runDir, 'personas'));
    await writeFile(
      join(runDir, 'personas', 'person.md'),
      '---\nid: person\n---\nA synthetic learner.\n'
    );
    for (const [id, kind, tag] of [
      ['selected', 'check', 'fixture'],
      ['excluded', 'check', 'fixture'],
      ['wrong-tag', 'check', 'other'],
      ['wrong-kind', 'mission', 'fixture'],
    ]) {
      await writeFile(
        join(runDir, 'stories', `${id}.md`),
        `---\nid: ${id}\nkind: ${kind}\n${kind === 'mission' ? 'persona: person\n' : ''}title: ${id}\nviewports: [desktop]\nrequires: {}\ntags: [${tag}]\nbudget: { steps: 1 }\n---\nExplore.\n`
      );
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main([
        '--adapter',
        adapterPath,
        '--model',
        'fake',
        '--provider',
        'fake',
        '--id',
        'selected',
        '--id',
        'wrong-tag',
        '--id',
        'wrong-kind',
        '--tag',
        'fixture',
        '--kind',
        'check',
      ]);
    } finally {
      log.mockRestore();
    }
    const [timestamp] = await readdir(join(runDir, 'runs'));
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    const summary = await report(join(runDir, 'runs', timestamp, 'summary.json'));
    expect(summary.records.map((record: { storyId: string }) => record.storyId)).toEqual([
      'selected',
    ]);
    expect(summary.outcomeCounts['blocked-precondition']).toBe(1);
    const args = ['--adapter', adapterPath, '--provider', 'fake', '--model', 'fake'];
    for (const filter of [
      ['--id', 'stale-id'],
      ['--tag', 'stale-tag'],
    ]) {
      await expect(main([...args, ...filter])).rejects.toThrow('No stories match');
    }
    vi.stubEnv('NOUS_E2E_DATA', '');
    const logExplicit = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main([...args, '--id', 'selected', '--run-dir', join(runDir, 'explicit')]);
    } finally {
      logExplicit.mockRestore();
    }
    expect((await report(join(runDir, 'explicit', 'summary.json'))).records).toHaveLength(1);
    vi.stubEnv('NOUS_E2E_DATA', runDir);
    await expect(
      main([
        '--adapter',
        adapterPath,
        '--concurrency',
        '0',
        '--model',
        'fake',
        '--provider',
        'fake',
      ])
    ).rejects.toThrow('positive integer');
    await expect(main(['--adapter', adapterPath])).rejects.toThrow('--model and --provider');
  });
});
