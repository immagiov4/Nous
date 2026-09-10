import type { DiagnosticAdapter, DiagnosticStage } from './diagnosticFlow.ts';

const stages: readonly DiagnosticStage[] = [
  {
    kind: 'self-assessment',
    id: 'topics',
    title: 'Partiamo da quello che conosci già.',
    topics: [
      {
        id: 'marketing',
        title: 'Marketing',
        children: [
          {
            id: 'audience',
            title: 'Pubblico',
            children: [
              { id: 'needs', title: 'Bisogni', children: [] },
              { id: 'segmentation', title: 'Segmentazione', children: [] },
            ],
          },
          { id: 'positioning', title: 'Posizionamento', children: [] },
          { id: 'communication', title: 'Comunicazione', children: [] },
        ],
      },
    ],
  },
  {
    kind: 'round',
    id: 'round-a',
    title: 'Vediamo come ragioni.',
    questions: [
      {
        id: 'audience-example',
        topic: 'Pubblico · Bisogni',
        format: 'text',
        prompt:
          'Una libreria vuole attirare nuovi lettori. Come individueresti un bisogno del suo pubblico?',
      },
      {
        id: 'positioning-example',
        topic: 'Posizionamento',
        format: 'choice',
        prompt: 'Quale proposta distingue meglio la libreria per le famiglie del quartiere?',
        options: [
          { id: 'family', text: 'Letture condivise per genitori e bambini, ogni sabato.' },
          { id: 'general', text: 'Libri per tutti i gusti.' },
          { id: 'size', text: 'Il nostro catalogo contiene molti titoli.' },
          { id: 'discount', text: 'Sconti su alcuni libri.' },
        ],
      },
    ],
  },
  {
    kind: 'round',
    id: 'round-b',
    title: 'Approfondiamo un punto.',
    questions: [
      {
        id: 'distinction',
        topic: 'Pubblico · Segmentazione',
        format: 'text',
        prompt: 'Come distingueresti due gruppi di lettori con bisogni diversi?',
      },
    ],
  },
  {
    kind: 'complete',
    id: 'end',
    title: 'Da dove partire',
    feedback:
      'Riprendiamo la distinzione fra pubblico e bisogni: ci aiuterà a capire a chi rivolgere una proposta. Da lì potremo lavorare sul posizionamento della libreria.',
  },
];

/** Fixed fixtures exercise presentation only; they do not evaluate answers or choose a curriculum. */
export function createDiagnosticDemoAdapter(failFirst = false) {
  const accepted = new Map<string, DiagnosticStage>();
  let shouldFail = failFirst;
  const adapter: DiagnosticAdapter = {
    collectionId: 'diagnostic-preview',
    initial: stages[0],
    async submit(submission) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Simulated submission failure');
      }
      const previous = accepted.get(submission.requestId);
      if (previous) return previous;
      const next = stages[stages.findIndex(stage => stage.id === submission.stageId) + 1];
      if (!next) throw new Error('No next fixture');
      accepted.set(submission.requestId, next);
      return next;
    },
  };
  return adapter;
}
