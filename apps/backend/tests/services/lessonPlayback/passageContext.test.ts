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

test('keeps an open code fence local to its authored content block', () => {
  const sources = [
    { type: 'markdown' as const, markdown: '## Primo tema\n\nPrimo passaggio.\n\n```sh\n# Codice' },
    {
      type: 'markdown' as const,
      markdown: '## Secondo tema\n\nSecondo passaggio.\n\n1. Uno.\n2. Due.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  for (const [index, speech] of ['Primo passaggio.', 'Secondo passaggio.'].entries()) {
    const block = blocks.find(block => block.speech.includes(speech));
    if (!block) throw new Error('Missing authored passage.');
    expect(getPlaybackPassageContext(block, sources)).toBe(sources[index].markdown);
  }
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
