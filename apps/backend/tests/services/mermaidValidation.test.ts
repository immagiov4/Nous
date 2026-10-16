import { execFile } from 'node:child_process';
import { beforeEach, expect, test, vi } from 'vitest';
import { classifyMermaidInputs, isParseableMermaid } from '../../src/services/mermaidValidation.js';
import { mermaidClassificationCases } from '../fixtures/mermaidClassification.js';
import { mermaidParseCases } from '../fixtures/mermaidParseCases.js';

vi.mock('node:child_process', { spy: true });

// Real parser startup is fixture preparation, not a ten-second parsing contract.
// Await process completion before registering assertions, retaining errors as test failures.
async function prepareParserResult<T>(parse: () => Promise<T>) {
  vi.mocked(execFile).mockClear();
  const serverWindow = globalThis.window;
  const [result] = await Promise.allSettled([parse()]);
  return {
    result,
    serverWindow,
    parserWindow: globalThis.window,
    processCount: vi.mocked(execFile).mock.calls.length,
  };
}

const isolatedParse = await prepareParserResult(() =>
  isParseableMermaid('classDiagram\nclass Animal', new AbortController().signal)
);
const orderedClassification = await prepareParserResult(() =>
  classifyMermaidInputs(
    [
      'graph = buildGraph()',
      'sequenceDiagram\nA->>B: Message',
      'packet = {}',
      'classDiagram\nclass Animal',
    ],
    new AbortController().signal
  )
);
const classificationFixtures = await prepareParserResult(() =>
  classifyMermaidInputs(
    mermaidClassificationCases.map(([code]) => code),
    new AbortController().signal
  )
);
const parseFixtures = [];
for (const [code, valid] of mermaidParseCases) {
  parseFixtures.push({
    code,
    valid,
    ...(await prepareParserResult(() => isParseableMermaid(code, new AbortController().signal))),
  });
}
const executionFailure = await prepareParserResult(() =>
  isParseableMermaid('unknownDiagram', new AbortController().signal)
);
const nonDiagramFixtures = [];
for (const code of [
  'unknownDiagram',
  'graph = buildGraph()',
  'sequenceDiagram()',
  'packet = {}',
  'architecture = {}',
  'gitGraph = {}',
  'pie = {}',
]) {
  nonDiagramFixtures.push({
    code,
    ...(await prepareParserResult(() =>
      isParseableMermaid(code, new AbortController().signal, true)
    )),
  });
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
});

test('keeps the parser DOM out of the server process', () => {
  expect(isolatedParse.result).toEqual({ status: 'fulfilled', value: true });
  expect(isolatedParse.parserWindow).toBe(isolatedParse.serverWindow);
  expect(isolatedParse.processCount).toBe(1);
});

test('classifies several inputs in order with one isolated process', () => {
  expect(orderedClassification.result).toEqual({
    status: 'fulfilled',
    value: [false, true, false, true],
  });
  expect(orderedClassification.processCount).toBe(1);
  expect(orderedClassification.parserWindow).toBe(orderedClassification.serverWindow);
});

test('starts no parser process for an empty classification batch', async () => {
  await expect(classifyMermaidInputs([], new AbortController().signal)).resolves.toEqual([]);
  expect(execFile).not.toHaveBeenCalled();
});

test('checks the lesson review classification fixtures against the real parser in one batch', () => {
  expect(classificationFixtures.result).toEqual({
    status: 'fulfilled',
    value: mermaidClassificationCases.map(([, isDiagram]) => isDiagram),
  });
  expect(classificationFixtures.processCount).toBe(1);
});

test.each(
  parseFixtures
)('checks the visual generation parse fixture against the real parser: $code', ({
  valid,
  result,
}) => {
  expect(result).toEqual({ status: 'fulfilled', value: valid });
});

test('reports parser execution failures separately from syntax rejection', () => {
  expect(executionFailure.result).toMatchObject({
    status: 'rejected',
    reason: new Error('Mermaid validation process failed.'),
  });
});

test('cancels the isolated parser with its caller', async () => {
  const controller = new AbortController();
  const reason = new Error('Artifact generation cancelled.');
  const parsing = isParseableMermaid('classDiagram\nclass Animal', controller.signal);
  controller.abort(reason);
  await expect(parsing).rejects.toBe(reason);
});

test.each(
  nonDiagramFixtures
)('classifies non-diagram input without changing artifact validation: $code', ({ result }) => {
  expect(result).toEqual({ status: 'fulfilled', value: false });
});
