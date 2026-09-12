import { expect, test } from 'vitest';
import { isParseableMermaid } from '../../src/services/mermaidValidation.js';

test('keeps the parser DOM out of the server process', async () => {
  const serverWindow = globalThis.window;
  await expect(
    isParseableMermaid('classDiagram\nclass Animal', new AbortController().signal)
  ).resolves.toBe(true);
  expect(globalThis.window).toBe(serverWindow);
});

test('reports parser execution failures separately from syntax rejection', async () => {
  await expect(isParseableMermaid('unknownDiagram', new AbortController().signal)).rejects.toThrow(
    'Mermaid validation process failed.'
  );
});

test('cancels the isolated parser with its caller', async () => {
  const controller = new AbortController();
  const parsing = isParseableMermaid('classDiagram\nclass Animal', controller.signal);
  controller.abort();
  await expect(parsing).rejects.toThrow();
});
