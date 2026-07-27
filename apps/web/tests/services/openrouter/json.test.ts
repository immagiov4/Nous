import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseCleanJson } from '../../../services/openrouter/json.ts';

test('parseCleanJson preserves fenced Markdown inside an outer JSON fence', () => {
  const contentMarkdown = 'Prima\n\n```sh\nuname -r\n```\n\nDopo';
  const raw = `\`\`\`json\n${JSON.stringify({ contentMarkdown })}\n\`\`\``;

  assert.equal(parseCleanJson<{ contentMarkdown: string }>(raw).contentMarkdown, contentMarkdown);
});

test('parseCleanJson repairs raw newlines and invalid backslashes inside strings', () => {
  const raw = `{
    "contentMarkdown": "Linea 1
Linea 2 con \\m escape rotto",
    "quiz": [],
    "imagePlacements": []
  }`;

  const parsed = parseCleanJson<{
    contentMarkdown: string;
    quiz: unknown[];
    imagePlacements: unknown[];
  }>(raw);

  assert.equal(parsed.contentMarkdown, 'Linea 1\nLinea 2 con \\m escape rotto');
  assert.deepEqual(parsed.quiz, []);
  assert.deepEqual(parsed.imagePlacements, []);
});

test('parseCleanJson completes truncated JSON returned by the model', () => {
  const raw = `{
    "contentMarkdown": "Lezione generata",
    "quiz": [
      { "question": "Q1", "options": ["A", "B"], "correctIndex": 0 }
    ],
    "imagePlacements": [`;

  const parsed = parseCleanJson<{
    contentMarkdown: string;
    quiz: Array<{ question: string; options: string[]; correctIndex: number }>;
    imagePlacements: unknown[];
  }>(raw);

  assert.equal(parsed.contentMarkdown, 'Lezione generata');
  assert.equal(parsed.quiz.length, 1);
  assert.deepEqual(parsed.imagePlacements, []);
});

test('parseCleanJson throws a friendly error when the payload is irrecoverable', () => {
  assert.throws(
    () => parseCleanJson<{ ok: boolean }>('non-json-response'),
    /Il modello ha restituito una risposta incompleta o non valida\./
  );
});
