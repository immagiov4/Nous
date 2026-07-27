import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clipPdfSourceText } from '../../../services/openrouter/pdfReasoning.ts';

test('clipPdfSourceText keeps full text when it fits the caller budget', () => {
  assert.equal(clipPdfSourceText('Alpha\n\nBeta', 20), 'Alpha\n\nBeta');
});

test('clipPdfSourceText uses only eighty percent of source budget when truncating', () => {
  const clipped = clipPdfSourceText('A'.repeat(120), 100);
  const [sourceText, marker] = clipped.split('\n\n');

  assert.equal(sourceText.length, 80);
  assert.equal(marker, '[ESTRATTO PDF TRONCATO PER LIMITI DI CONTESTO]');
});
