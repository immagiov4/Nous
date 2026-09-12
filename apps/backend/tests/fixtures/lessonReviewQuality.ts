import type { LessonContentDraft } from '../../src/services/lessonGenerationTypes.js';

export const automationCourse = {
  description:
    'Distinguere assistenza, esecuzione con approvazione e autonomia entro limiti, riconoscendo chi decide e quando si può interrompere il lavoro.',
  generationNotes:
    'Italiano naturale. Spiega positivamente ogni configurazione. Inserisci una pausa applicativa dopo aver insegnato i concetti necessari.',
  pedagogicalContext:
    'Prima lezione per un responsabile di ufficio senza esperienza di programmazione. Sa che un programma può elaborare dati, ma non conosce le configurazioni di delega. Deve motivare quale configurazione è adatta a un caso e riconoscere la necessità di autorizzazione e arresto. Il termine lights-off fa parte del corso e va spiegato. Non trattare API, tipi di programmazione o infrastrutture.',
  sectionTitle: 'Delegare un compito a un sistema automatico',
  sourceContext:
    'Materiale didattico controllato. Un sistema di assistenza prepara una proposta che una persona valuta e applica. Nell’esecuzione con approvazione il sistema prepara ed esegue l’azione soltanto dopo il consenso umano. Nell’autonomia entro limiti il sistema esegue le azioni comprese in un’autorizzazione già definita; una persona mantiene la responsabilità, stabilisce i limiti e può interromperlo. In questo corso lights-off indica l’esecuzione senza presidio umano continuo, entro quei limiti. Non significa assenza di responsabilità. Per esempio, un ufficio può autorizzare l’invio automatico di promemoria già approvati, ma richiedere un consenso specifico per modificare un contratto. Un responsabile controlla i risultati e può sospendere gli invii.',
};

export const flawedAutomationLesson: LessonContentDraft = {
  contentBlocks: [
    {
      type: 'markdown',
      markdown:
        '## Tre configurazioni, tre punti di controllo\n\nLa delega non è soltanto velocità, ma un nuovo paradigma. L’autonomia non è assenza di review: un owner governa rollout, feedback e deployment.',
    },
    {
      type: 'inline-quiz',
      quiz: {
        correctIndex: 0,
        exerciseType: 'concept-check',
        explanation: 'Lights-off richiede limiti autorizzati e una possibilità di arresto.',
        options: [
          'Lights-off entro limiti approvati, con arresto disponibile.',
          'Lights-off senza responsabilità umana.',
          'Assistenza che esegue da sola qualsiasi azione.',
          'Esecuzione con approvazione che ignora il consenso.',
        ],
        question:
          'Un ufficio vuole inviare promemoria già approvati senza presidio continuo. Qual è la diagnosi più corretta? Any',
      },
    },
    {
      type: 'markdown',
      markdown:
        'L’assistenza prepara una proposta che una persona applica. Nell’esecuzione con approvazione il sistema agisce dopo il consenso. Nell’autonomia entro limiti esegue azioni già autorizzate, sotto la responsabilità di una persona che può fermarlo. Lights-off indica questa esecuzione senza presidio continuo. I promemoria possono rientrare nell’autorizzazione; la modifica di un contratto richiede invece un consenso specifico.',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};
