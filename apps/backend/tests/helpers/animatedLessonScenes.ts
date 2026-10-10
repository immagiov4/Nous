import type { GuidedPathLessonScene, ProportionalLessonScene } from '@shared/lessonScene';

// The two examples in notes-live-lab/interactive-model.mjs, with description mapped to body.
export const proportionalScene: ProportionalLessonScene = {
  type: 'proportional',
  autoplay: true,
  durationMs: 9600,
  title: 'Più repliche, più memoria',
  body: 'Ogni replica richiede la stessa quantità di memoria.',
  inputLabel: 'Repliche del servizio',
  unitLabel: 'replica',
  min: 1,
  max: 6,
  initial: 2,
  amountPerUnit: 128,
  outputUnit: 'MB',
  outputLabel: 'Memoria totale',
  assumption: 'Modello semplificato: 128 MB per replica, senza costi condivisi.',
  items: [],
  groups: [],
  note: '',
  quote: '',
};

export const guidedPathScene: GuidedPathLessonScene = {
  type: 'guided-path',
  autoplay: true,
  narration:
    'L’interfaccia invia la richiesta di salvataggio. Prima di procedere, l’API verifica che i dati ricevuti siano validi. Il servizio applica quindi le regole per creare la risorsa. Infine l’archivio conserva la nuova risorsa.',
  title: 'Il viaggio di una richiesta',
  body: 'Segui una richiesta di salvataggio dal browser all’archivio.',
  steps: [
    {
      anchor: 'L’interfaccia',
      label: 'Interfaccia',
      detail: 'La persona preme Salva. L’interfaccia invia la richiesta.',
    },
    { anchor: 'l’API', label: 'API', detail: 'L’API controlla che i dati ricevuti siano validi.' },
    {
      anchor: 'Il servizio',
      label: 'Servizio',
      detail: 'Il servizio applica le regole per creare la risorsa.',
    },
    { anchor: 'l’archivio', label: 'Archivio', detail: 'L’archivio conserva la nuova risorsa.' },
  ],
  items: [],
  groups: [],
  note: '',
  quote: '',
};
