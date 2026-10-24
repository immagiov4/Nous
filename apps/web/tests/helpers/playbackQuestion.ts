import type { LessonScene } from '@shared/lessonScene';
import type { PlaybackQuestionContext } from '@shared/playbackQuestionContext';

export const controllerScene: LessonScene = {
  type: 'steps',
  title: 'Individuare il controller di dominio',
  body: '',
  note: '',
  quote: '',
  groups: [],
  items: [
    'Risoluzione DNS',
    'Ricerca dei record SRV',
    'Risposta del DNS',
    'Contatto con il controller',
    'Informazioni per le GPO',
    'Valutazione dei permessi',
  ].map(label => ({ label, detail: `Passaggio: ${label}.`, icon: '' })),
};

export const playbackQuestion = {
  passage: {
    title: 'Ricerca del controller',
    text: 'Il client cerca il controller. Il server valuta i permessi.',
  },
  heardSentence: 'Il client cerca il controller.',
  voiceTime: 4,
  visual: {
    kind: 'scene',
    title: controllerScene.title,
    scene: controllerScene,
    renderedText: controllerScene.items.map(item => item.label).join(' '),
    highlighted: [{ id: 'item:0', text: 'Risoluzione DNS' }],
  },
} satisfies PlaybackQuestionContext;
