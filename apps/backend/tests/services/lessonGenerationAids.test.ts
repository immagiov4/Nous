import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  createLessonLearningAidGenerator,
  normalizeLessonLearningAids,
} from '../../src/services/lessonGenerationAids.js';

test('normalizes optional learning aids with the previous caps, stable ids, exact anchors, and deduplication', () => {
  const result = normalizeLessonLearningAids(
    [
      {
        anchorHeading: 'Modello OSI',
        content: 'Un insieme condiviso di regole di comunicazione.',
        kind: 'definition',
        title: 'Protocollo',
      },
      {
        anchorHeading: 'Modello OSI',
        content: 'Duplicato da eliminare.',
        kind: 'definition',
        title: 'Protocollo',
      },
      {
        anchorHeading: 'Incapsulamento',
        content: 'Ogni livello aggiunge le proprie informazioni di controllo.',
        kind: 'definition',
        title: 'Incapsulamento',
      },
      {
        anchorHeading: null,
        content: 'Terza definizione oltre il limite.',
        kind: 'definition',
        title: 'Livello',
      },
      {
        anchorHeading: 'heading inesistente',
        content: 'T = L / R',
        kind: 'formula',
        title: 'Tempo di trasmissione',
      },
      {
        anchorHeading: null,
        content: "L'incapsulamento somiglia a inserire una busta dentro un'altra.",
        kind: 'analogy',
        title: 'Buste dentro buste',
      },
    ],
    '## Modello OSI\n\nContenuto.\n\n## Incapsulamento\n\nAltro contenuto.'
  );

  expect(result.map(aid => aid.kind)).toEqual(['definition', 'definition', 'formula', 'analogy']);
  expect(result.map(aid => aid.id)).toEqual([
    'learning-aid-definition-protocollo',
    'learning-aid-definition-incapsulamento',
    'learning-aid-formula-tempo-di-trasmissione',
    'learning-aid-analogy-buste-dentro-buste',
  ]);
  expect(result[0]?.anchorHeading).toBe('Modello OSI');
  expect(result[2]?.anchorHeading).toBeUndefined();
});

test('retries a transient provider failure before dropping optional learning aids', async () => {
  vi.useFakeTimers();
  const requestDrafts = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('temporary upstream failure'), { status: 502 }))
    .mockResolvedValueOnce([]);
  const generate = createLessonLearningAidGenerator(requestDrafts);

  try {
    const resultPromise = generate({
      config: {} as GlobalModelConfig,
      contentMarkdown: '## Contenuto\n\nTesto della lezione.',
      sectionDescription: 'Descrizione.',
      sectionTitle: 'Titolo',
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await resultPromise).toEqual([]);
    expect(requestDrafts).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('ignores unsupported learning-aid kinds received at runtime', () => {
  const result = normalizeLessonLearningAids(
    [
      {
        anchorHeading: null,
        content: 'Una scelta operativa dello switch.',
        kind: 'symbol',
        title: 'Decisione di inoltro',
      },
    ] as never,
    '## Code di rete\n\nContenuto.'
  );

  expect(result).toEqual([]);
});

test('skips malformed learning aids without discarding valid siblings', () => {
  const result = normalizeLessonLearningAids(
    [
      null,
      { content: 42, kind: 'definition', title: 'Non valida' },
      {
        anchorHeading: 'Code di rete',
        content: 'Una struttura che conserva pacchetti in attesa.',
        kind: 'definition',
        title: 'Coda',
      },
    ],
    '## Code di rete\n\nContenuto.'
  );

  expect(result).toEqual([
    {
      anchorHeading: 'Code di rete',
      content: 'Una struttura che conserva pacchetti in attesa.',
      id: 'learning-aid-definition-coda',
      kind: 'definition',
      title: 'Coda',
    },
  ]);
});

test('optional learning-aid failure does not fail the lesson', async () => {
  const requestDrafts = vi.fn().mockRejectedValue(new Error('invalid provider response'));
  const generate = createLessonLearningAidGenerator(requestDrafts);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await expect(
      generate({
        config: {} as GlobalModelConfig,
        contentMarkdown: '## Contenuto\n\nTesto della lezione.',
        sectionDescription: 'Descrizione.',
        sectionTitle: 'Titolo',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual([]);
    expect(requestDrafts).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});
