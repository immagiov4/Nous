import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { createLaboratoryTextAttachment } from '../../../services/laboratory/attachments.ts';
import { CURRENT_LABORATORY_SCHEMA_VERSION } from '../../../services/laboratory/state.ts';

vi.mock('../../../services/openrouter/config.ts', () => ({
  MEDIUM_REASONING_CONFIG: { effort: 'medium', exclude: true },
  MAX_OUTPUT_TOKENS: 32000,
  MODEL_ASSESSMENT: 'mistralai/mistral-small-2603',
  MODEL_FLASH: 'openai/gpt-5.4-nano',
  MODEL_PDF_IMAGE_CAPTION: 'nvidia/nemotron-nano-12b-v2-vl',
  MODEL_REASONING: 'openai/gpt-5.4-mini',
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.test',
  resolveOpenRouterModel: (model: string) => model,
}));

const { evaluateLaboratoryExercise, generateLaboratory } = await import(
  '../../../services/openrouter/laboratory.ts'
);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

test('generateLaboratory normalizes the returned exercises into persisted laboratory state', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Laboratorio Applicativo',
              summary: 'Esercizi progressivi sul materiale.',
              exercises: [
                {
                  title: 'Analisi guidata',
                  brief: 'Analizza il materiale e produci una sintesi.',
                  instructionsMarkdown: '## Consegna\n\nCarica una nota ragionata.',
                  requirements: [
                    'Usa il repository assegnato.',
                    'Mostra almeno una evidenza concreta.',
                  ],
                  approachMarkdown:
                    '## Metodo\n\nParti dai vincoli del caso e costruisci una checklist.',
                  exampleMarkdown:
                    '## Esempio guidato\n\nSu un modulo analogo, isola prima il flusso principale e poi annota un problema osservabile.',
                  internalNotes: ['Cerca esempi concreti.'],
                },
              ],
            }),
          },
        },
      ],
    }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Laboratorio Applicativo',
              summary: 'Esercizi progressivi sul materiale.',
              exercises: [
                {
                  title: 'Analisi guidata',
                  brief: 'Analizza il materiale e produci una sintesi.',
                  instructionsMarkdown:
                    '## Scenario\n\nHai ricevuto un piccolo servizio Node con logging incompleto.\n\n## Task\n\nDocumenta il problema e proponi una correzione motivata.\n\n## Deliverables\n\n- Una nota tecnica.\n- Un elenco di evidenze.',
                  requirements: [
                    'Lavora sul servizio Node assegnato, senza cambiare scenario.',
                    'Cita almeno una evidenza osservabile del repository.',
                    'Proponi una correzione motivata e verificabile.',
                  ],
                  approachMarkdown:
                    '## Metodo\n\n1. Identifica i file rilevanti.\n2. Trasforma i vincoli in checklist.\n3. Collega ogni proposta a una evidenza concreta.',
                  exampleMarkdown:
                    '## Esempio guidato\n\nIn un servizio analogo, si parte da un endpoint semplice, si osserva il log prodotto e si annota dove manca il contesto minimo per il debug.',
                  internalNotes: ['Cerca esempi concreti.'],
                },
              ],
            }),
          },
        },
      ],
    }),
  });

  const laboratory = await generateLaboratory({
    learningPlan: {
      title: 'Percorso',
      summary: 'Sintesi',
      sections: [
        {
          id: 'lesson-1',
          title: 'Intro',
          description: 'Base',
          isCompleted: false,
          type: 'core',
        },
      ],
    },
    source: {
      kind: 'codebase-bundle',
      name: 'workspace.zip',
      aggregatedText: '--- START OF FILE: src/app.ts ---\nconsole.log("ok")',
      files: [{ path: 'src/app.ts', text: 'console.log("ok")' }],
      stats: {
        includedFileCount: 1,
        skippedFileCount: 0,
        totalCharacterCount: 24,
        truncatedFileCount: 0,
      },
    },
  });

  assert.equal(laboratory.status, 'ready');
  assert.equal(laboratory.schemaVersion, CURRENT_LABORATORY_SCHEMA_VERSION);
  assert.equal(laboratory.title, 'Laboratorio Applicativo');
  assert.equal(laboratory.exercises.length, 1);
  assert.equal(laboratory.exercises[0]?.attachments.length, 0);
  assert.deepEqual(laboratory.exercises[0]?.requirements, []);
  assert.equal(laboratory.exercises[0]?.evaluation, null);

  const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
  const firstSystemPrompt = String(firstRequest.messages?.[0]?.content || '');
  assert.match(firstSystemPrompt, /exampleMarkdown/);
  assert.doesNotMatch(firstSystemPrompt, /"requirements"/);
  assert.match(firstSystemPrompt, /non chiedere mai allo studente di scegliere lo scenario/i);
  assert.match(firstSystemPrompt, /niente code fence/i);
  assert.match(firstSystemPrompt, /Contenuti richiesti per approachMarkdown/i);
  assert.match(firstSystemPrompt, /usa liste solo quando chiariscono davvero/i);
  assert.match(firstSystemPrompt, /Deliverables deve essere concreta e verificabile/i);
  assert.match(firstSystemPrompt, /quale artefatto produrre/i);
  assert.match(firstSystemPrompt, /progressione propedeutic/i);
  assert.match(firstSystemPrompt, /distribuisci gli esercizi su porzioni diverse del materiale/i);
  assert.match(firstSystemPrompt, /non dire mai allo studente quanti # usare/i);
  assert.match(firstSystemPrompt, /non imporre tabelle markdown/i);

  const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body || '{}'));
  const secondSystemPrompt = String(secondRequest.messages?.[0]?.content || '');
  assert.match(secondSystemPrompt, /revisore QA/i);
  assert.match(secondSystemPrompt, /scenario specifico/i);
  assert.match(secondSystemPrompt, /ripulisci la forma markdown/i);
  assert.match(secondSystemPrompt, /Deliverables sia concreta, non generica/i);
  assert.match(
    secondSystemPrompt,
    /elimina ogni istruzione rivolta allo studente su marker markdown/i
  );
  assert.match(secondSystemPrompt, /propedeutic/i);
  assert.match(
    secondSystemPrompt,
    /usa liste markdown vere solo quando il contenuto e davvero enumerativo/i
  );
});

test('generateLaboratory uses PDF source excerpts distributed across the document', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Laboratorio Mixing',
              summary: 'Copertura distribuita.',
              exercises: [
                {
                  title: 'Tracing workflow',
                  brief: 'Confronta diversi punti del libro.',
                  instructionsMarkdown: '## Traccia\n\nAnalizza il caso.',
                  approachMarkdown: '## Metodo\n\nParti dai segnali ricorrenti.',
                  exampleMarkdown: '## Indizio\n\nConfronta aperture e capitoli avanzati.',
                  internalNotes: [],
                },
              ],
            }),
          },
        },
      ],
    }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Laboratorio Mixing',
              summary: 'Copertura distribuita.',
              exercises: [
                {
                  title: 'Tracing workflow',
                  brief: 'Confronta diversi punti del libro.',
                  instructionsMarkdown: '## Traccia\n\nAnalizza il caso.',
                  approachMarkdown: '## Metodo\n\nParti dai segnali ricorrenti.',
                  exampleMarkdown: '## Indizio\n\nConfronta aperture e capitoli avanzati.',
                  internalNotes: [],
                },
              ],
            }),
          },
        },
      ],
    }),
  });

  await generateLaboratory({
    documentIndex: {
      kind: 'pdf-text-index',
      parsedAt: '2026-04-09T10:00:00.000Z',
      pageCount: 437,
      chunks: Array.from({ length: 10 }, (_, index) => ({
        id: `chunk-${String(index + 1).padStart(3, '0')}`,
        text: `Contenuto ${index + 1}`,
        headingPath: [`Capitolo ${index + 1}`],
        sequence: index,
        startOffset: index * 100,
        endOffset: index * 100 + 50,
        pageStart: index * 40 + 1,
        pageEnd: index * 40 + 20,
      })),
    },
    learningPlan: {
      title: 'Mixing',
      summary: 'Percorso completo',
      sections: [
        {
          id: 'lesson-1',
          title: 'Intro',
          description: 'Base',
          isCompleted: false,
          type: 'core',
        },
      ],
    },
    source: {
      kind: 'pdf',
      file: {
        name: 'mixing.pdf',
        mimeType: 'application/pdf',
        data: 'ZmFrZQ==',
      },
    },
  });

  const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
  const userPrompt = String(firstRequest.messages?.[1]?.content || '');

  assert.match(userPrompt, /Estratto distribuito sull intero documento/i);
  assert.match(userPrompt, /CHUNK chunk-001/);
  assert.match(userPrompt, /CHUNK chunk-010/);
  assert.match(userPrompt, /Pagine: pag\. 1-20/);
  assert.match(userPrompt, /Pagine: pag\. 361-380/);
});

test('evaluateLaboratoryExercise returns the verified evaluation payload', async () => {
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 68,
                confidenceScore: 55,
                confidenceSummary: 'Bozza iniziale con copertura parziale.',
                summary: 'Prima valutazione.',
                strengths: ['C e un tentativo coerente'],
                improvements: ['Servono piu dettagli'],
                caveats: ['Manca una prova chiave'],
              }),
            },
          },
        ],
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 72,
                confidenceScore: 61,
                confidenceSummary: 'Valutazione verificata sugli allegati disponibili.',
                summary: 'Buon tentativo con margini di chiarimento.',
                strengths: ['Consegna coerente con la traccia'],
                improvements: ['Rendi piu esplicita la motivazione tecnica'],
                caveats: ['La prova resta limitata agli allegati testuali'],
              }),
            },
          },
        ],
      }),
    });

  const evaluation = await evaluateLaboratoryExercise({
    exercise: {
      attachments: [
        createLaboratoryTextAttachment({ content: 'La mia soluzione', name: 'solution.md' }),
      ],
      approachMarkdown: '## Metodo\n\nParti dai requisiti e verifica ogni scelta.',
      brief: 'Produci una nota tecnica.',
      evaluation: null,
      exampleMarkdown: '## Indizio\n\nSu un caso analogo, esplicita prima vincoli e output atteso.',
      generatedAt: '2026-03-20T10:00:00.000Z',
      id: 'lab-1',
      internalNotes: [],
      instructionsMarkdown: '## Consegna\n\nSpiega la tua soluzione.',
      requirements: ['Documenta il ragionamento.', 'Motiva le scelte con evidenze.'],
      title: 'Esercizio 1',
      updatedAt: '2026-03-20T10:00:00.000Z',
    },
    learningPlan: {
      title: 'Percorso',
      summary: 'Sintesi',
      sections: [
        {
          id: 'lesson-1',
          title: 'Intro',
          description: 'Base',
          isCompleted: false,
          type: 'core',
        },
      ],
    },
    source: {
      kind: 'codebase-bundle',
      name: 'workspace.zip',
      aggregatedText: '--- START OF FILE: src/app.ts ---\nconsole.log("ok")',
      files: [{ path: 'src/app.ts', text: 'console.log("ok")' }],
      stats: {
        includedFileCount: 1,
        skippedFileCount: 0,
        totalCharacterCount: 24,
        truncatedFileCount: 0,
      },
    },
  });

  assert.equal(evaluation.score, 72);
  assert.equal(evaluation.confidenceScore, 61);
  assert.match(evaluation.summary, /Buon tentativo/i);
  assert.deepEqual(evaluation.caveats, ['La prova resta limitata agli allegati testuali']);
});
