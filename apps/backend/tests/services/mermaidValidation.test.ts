import { execFile } from 'node:child_process';
import { beforeEach, expect, test, vi } from 'vitest';
import { classifyMermaidInputs, isParseableMermaid } from '../../src/services/mermaidValidation.js';
import { mermaidClassificationCases } from '../fixtures/mermaidClassification.js';
import { mermaidParseCases } from '../fixtures/mermaidParseCases.js';

vi.mock('node:child_process', { spy: true });

const classDiagram = 'classDiagram\nclass Animal';

beforeEach(() => {
  vi.mocked(execFile).mockClear();
});

test('keeps the parser DOM out of the server process', async () => {
  const serverWindow = globalThis.window;
  await expect(isParseableMermaid(classDiagram, new AbortController().signal)).resolves.toBe(true);
  expect(globalThis.window).toBe(serverWindow);
  expect(execFile).toHaveBeenCalledOnce();
});

test('classifies several inputs in order with one isolated process', async () => {
  const serverWindow = globalThis.window;
  await expect(
    classifyMermaidInputs(
      ['graph = buildGraph()', 'sequenceDiagram\nA->>B: Message', 'packet = {}', classDiagram],
      new AbortController().signal
    )
  ).resolves.toEqual([false, true, false, true]);
  expect(execFile).toHaveBeenCalledOnce();
  expect(globalThis.window).toBe(serverWindow);
});

test('starts no parser process for an empty classification batch', async () => {
  await expect(classifyMermaidInputs([], new AbortController().signal)).resolves.toEqual([]);
  expect(execFile).not.toHaveBeenCalled();
});

test('checks the lesson review classification fixtures against the real parser in one batch', async () => {
  await expect(
    classifyMermaidInputs(
      mermaidClassificationCases.map(([code]) => code),
      new AbortController().signal
    )
  ).resolves.toEqual(mermaidClassificationCases.map(([, isDiagram]) => isDiagram));
  expect(execFile).toHaveBeenCalledOnce();
});

test.each(
  mermaidParseCases
)('checks the visual generation parse fixture against the real parser: %s', async (code, valid) => {
  await expect(isParseableMermaid(code, new AbortController().signal)).resolves.toBe(valid);
});

test('reports parser execution failures separately from syntax rejection', async () => {
  await expect(isParseableMermaid('unknownDiagram', new AbortController().signal)).rejects.toThrow(
    'Mermaid validation process failed.'
  );
});

test('cancels the isolated parser with its caller', async () => {
  const controller = new AbortController();
  const reason = new Error('Artifact generation cancelled.');
  const parsing = isParseableMermaid(classDiagram, controller.signal);
  controller.abort(reason);
  await expect(parsing).rejects.toBe(reason);
});

test.each([
  'unknownDiagram',
  'graph = buildGraph()',
  'sequenceDiagram()',
  'packet = {}',
  'architecture = {}',
  'gitGraph = {}',
  'pie = {}',
])('classifies non-diagram input without changing artifact validation: %s', async code => {
  await expect(isParseableMermaid(code, new AbortController().signal, true)).resolves.toBe(false);
});
