import { getPlaybackPassageContext, segmentLessonPlayback } from '@shared/lessonPlayback';
import { expect, test } from 'vitest';

test.each([
  false,
  true,
])('resolves an introductory passage and its list within authored headings (separate blocks: %s)', separate => {
  const section =
    '## Autenticazione\n\nIl flusso è questo:\n\n1. Cercare il controller.\n2. Verificare le credenziali.';
  const parts = separate
    ? [
        '## Altro\n\nUn altro tema.',
        '## Autenticazione',
        'Il flusso è questo:',
        '1. Cercare il controller.\n2. Verificare le credenziali.',
        '## Fine\n\nUn tema successivo.',
      ]
    : [`## Altro\n\nUn altro tema.\n\n${section}\n\n## Fine\n\nUn tema successivo.`];
  const sources = parts.map(markdown => ({ type: 'markdown' as const, markdown }));
  const block = segmentLessonPlayback(sources).find(block =>
    block.speech.endsWith('Il flusso è questo:')
  );
  if (!block) throw new Error('Missing introductory passage.');
  expect(getPlaybackPassageContext(block, sources)).toBe(section);
});

test('keeps heading syntax in authored code inside the same source section', () => {
  const markdown =
    '## Configurazione\n\nI passi sono questi:\n\n```sh\n# Questa è una riga di codice\necho esempio\n```\n\nEseguire il comando.\n\n## Fine\n\nAltro.';
  const sources = [{ type: 'markdown' as const, markdown }];
  const block = segmentLessonPlayback(sources).find(block =>
    block.speech.endsWith('I passi sono questi:')
  );
  if (!block) throw new Error('Missing introductory passage.');
  expect(getPlaybackPassageContext(block, sources)).toBe(
    '## Configurazione\n\nI passi sono questi:\n\n```sh\n# Questa è una riga di codice\necho esempio\n```\n\nEseguire il comando.'
  );
});

test('omits media metadata while preserving literal code and source mathematics', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '## Tema\n\nIl percorso è questo:\n\n{{PDF_IMAGE:lost|alt=Metadato|caption=Non è un fatto}}\n\n![Altri metadati](missing.png)\n\nIl codice è `{{PDF_IMAGE:literal}}` e la formula è $x$.\n\n## Altro\n\nAltro tema.',
    },
  ];
  const block = segmentLessonPlayback(sources).find(block =>
    block.speech.endsWith('Il percorso è questo:')
  );
  if (!block) throw new Error('Missing introductory passage.');
  expect(getPlaybackPassageContext(block, sources)).toBe(
    '## Tema\n\nIl percorso è questo:\n\n\n\n\n\nIl codice è `{{PDF_IMAGE:literal}}` e la formula è $x$.'
  );
});
