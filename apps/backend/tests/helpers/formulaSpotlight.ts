import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';

// Raw notation stays ASCII; ordinary prose preserves Unicode cue anchors in the Bun command.
export const FORMULA_SPOTLIGHT_MARKDOWN =
  String.raw`Consideriamo $p_\theta(y\mid x)$. ` +
  'La probabilità, indicata con p, è la stima del modello. I parametri, indicati con theta, sono i valori appresi. Il risultato, indicato con y, è ciò che prevediamo. La barra verticale significa dato: introduce la condizione. L’informazione osservata, indicata con x, è ciò che conosciamo.';
export const FORMULA_SPOTLIGHT_SPEECH = segmentLessonPlayback([
  { type: 'markdown', markdown: FORMULA_SPOTLIGHT_MARKDOWN },
])[0].speech;
export const formulaSpotlight = {
  type: 'formula-spotlight',
  title: 'Una probabilità condizionata',
  body: '',
  items: [],
  groups: [],
  quote: '',
  note: '',
  formula: String.raw`\nousSymbol{probability}_{\nousSymbol{theta}}(\nousSymbol{outcome}\nousSymbol{given}\nousSymbol{input})`,
  symbols: [
    {
      id: 'probability',
      latex: 'p',
      name: 'Probabilità',
      meaning: 'La stima assegnata dal modello.',
      anchor: 'La probabilità',
    },
    {
      id: 'theta',
      latex: String.raw`\theta`,
      name: 'Parametri',
      meaning: 'I valori appresi dal modello.',
      anchor: 'I parametri',
    },
    {
      id: 'outcome',
      latex: 'y',
      name: 'Risultato',
      meaning: 'L’esito da prevedere.',
      anchor: 'Il risultato',
    },
    {
      id: 'given',
      latex: String.raw`\mid`,
      name: 'Dato',
      meaning: 'La condizione della probabilità.',
      anchor: 'La barra verticale',
    },
    {
      id: 'input',
      latex: 'x',
      name: 'Informazione',
      meaning: 'Ciò che abbiamo osservato.',
      anchor: 'L’informazione',
    },
  ],
} satisfies LessonScene;

export const dictatedFormulaSpotlight = {
  type: 'formula-spotlight',
  title: '',
  body: '',
  quote: '',
  note: '',
  items: [],
  groups: [],
  formula: String.raw`\nousSymbol{x}\nousSymbol{plus}\nousSymbol{y}`,
  symbols: [
    { id: 'x', latex: 'x', name: 'Ics', meaning: 'Primo valore', anchor: 'ics' },
    { id: 'plus', latex: '+', name: 'Più', meaning: 'Somma', anchor: 'più' },
    { id: 'y', latex: 'y', name: 'Ipsilon', meaning: 'Secondo valore', anchor: 'ipsilon' },
  ],
} satisfies LessonScene;
