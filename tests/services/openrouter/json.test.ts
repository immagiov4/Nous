import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseCleanJson } from '../../../services/openrouter/json.ts';

test('parseCleanJson repairs raw newlines and invalid backslashes inside strings', () => {
  const raw = `{
    "contentMarkdown": "Linea 1
Linea 2 con \\m escape rotto",
    "quiz": [],
    "imagePlacements": []
  }`;

  const parsed = parseCleanJson<{ contentMarkdown: string; quiz: unknown[]; imagePlacements: unknown[] }>(raw);

  assert.equal(parsed.contentMarkdown, 'Linea 1\nLinea 2 con \\m escape rotto');
  assert.deepEqual(parsed.quiz, []);
  assert.deepEqual(parsed.imagePlacements, []);
});
