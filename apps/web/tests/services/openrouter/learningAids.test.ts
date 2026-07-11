import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const callOpenRouterMock = vi.fn();

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_FLASH: 'flash-model',
    callOpenRouter: callOpenRouterMock,
  };
});

const { generateLessonLearningAids, normalizeLessonLearningAids } = await import(
  '../../../services/openrouter/learningAids.ts'
);

beforeEach(() => {
  callOpenRouterMock.mockReset();
});

test('normalizes learning aids with stable ids, exact anchors, caps, and duplicate removal', () => {
  const lessonMarkdown = `## Modello OSI

Contenuto.

## Incapsulamento

Altro contenuto.`;

  const result = normalizeLessonLearningAids(
    {
      aids: [
        {
          kind: 'definition',
          title: 'Protocollo',
          content: 'Un insieme condiviso di regole di comunicazione.',
          anchorHeading: 'Modello OSI',
        },
        {
          kind: 'definition',
          title: 'Protocollo',
          content: 'Duplicato da eliminare.',
          anchorHeading: 'Modello OSI',
        },
        {
          kind: 'definition',
          title: 'Incapsulamento',
          content: 'Ogni livello aggiunge le proprie informazioni di controllo.',
          anchorHeading: 'Incapsulamento',
        },
        {
          kind: 'definition',
          title: 'Livello',
          content: 'Terza definizione oltre il limite.',
        },
        {
          kind: 'formula',
          title: 'Tempo di trasmissione',
          content: 'T = L / R',
          anchorHeading: 'Heading inesistente',
        },
        {
          kind: 'symbol',
          title: 'R',
          content: 'Velocita di trasmissione espressa in bit al secondo.',
        },
        {
          kind: 'analogy',
          title: 'Buste dentro buste',
          content: "L'incapsulamento somiglia a inserire una busta dentro un'altra.",
        },
        {
          kind: 'unsupported',
          title: 'Da ignorare',
          content: 'Tipo non valido.',
        },
      ],
    },
    lessonMarkdown
  );

  assert.equal(result.length, 5);
  assert.deepEqual(
    result.map(aid => aid.kind),
    ['definition', 'definition', 'formula', 'symbol', 'analogy']
  );
  assert.deepEqual(
    result.map(aid => aid.id),
    [
      'learning-aid-definition-protocollo',
      'learning-aid-definition-incapsulamento',
      'learning-aid-formula-tempo-di-trasmissione',
      'learning-aid-symbol-r',
      'learning-aid-analogy-buste-dentro-buste',
    ]
  );
  assert.equal(result[0]?.anchorHeading, 'Modello OSI');
  assert.equal(result[2]?.anchorHeading, undefined);
});

test('generates compact learning aids in the lesson language with a strict schema', async () => {
  callOpenRouterMock.mockResolvedValue(
    JSON.stringify({
      aids: [
        {
          kind: 'definition',
          title: 'Protocollo',
          content: 'Regole condivise per scambiare messaggi.',
          anchorHeading: 'Il problema della comunicazione',
        },
      ],
    })
  );

  const result = await generateLessonLearningAids({
    contentMarkdown: '## Il problema della comunicazione\n\nUna rete richiede regole condivise.',
    sectionDescription: 'Dai problemi generali ai protocolli di rete.',
    sectionTitle: 'Comunicare in rete',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, 'Protocollo');
  assert.equal(callOpenRouterMock.mock.calls.length, 1);

  const request = callOpenRouterMock.mock.calls[0]?.[0];
  assert.equal(request?.model, 'flash-model');
  assert.equal(request?.response_format?.type, 'json_schema');
  assert.match(String(request?.messages?.[1]?.content ?? ''), /stessa lingua della lezione/i);
  assert.match(String(request?.messages?.[1]?.content ?? ''), /massimo 2 definizioni/i);
  assert.match(String(request?.messages?.[1]?.content ?? ''), /non modificare il markdown/i);
  assert.match(String(request?.messages?.[1]?.content ?? ''), /simbolo convenzionale/i);
  assert.match(String(request?.messages?.[1]?.content ?? ''), /comprensibile da sola/i);
  assert.match(String(request?.messages?.[1]?.content ?? ''), /massimo 4 parole e 32 caratteri/i);
});

test('rejects conceptual phrases mislabeled as symbols', () => {
  const result = normalizeLessonLearningAids(
    {
      aids: [
        {
          kind: 'symbol',
          title: 'Decisione di inoltro',
          content: 'Una scelta operativa dello switch.',
          anchorHeading: null,
        },
        {
          kind: 'symbol',
          title: 'λ',
          content: 'Tasso medio di arrivo.',
          anchorHeading: null,
        },
      ],
    },
    '# Code di rete'
  );

  assert.deepEqual(
    result.map(aid => aid.title),
    ['λ']
  );
});

test('learning-aid generation is optional and does not fail the lesson', async () => {
  callOpenRouterMock.mockRejectedValue(new Error('temporary model failure'));

  const result = await generateLessonLearningAids({
    contentMarkdown: '## Contenuto\n\nTesto della lezione.',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Titolo',
  });

  assert.deepEqual(result, []);
});
