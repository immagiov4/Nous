export const LESSON_INSTRUCTION_PACK_IDS = [
  'mathematics',
  'code',
  'technical-sources',
  'visual-learning',
] as const;

export type LessonInstructionPackId = (typeof LESSON_INSTRUCTION_PACK_IDS)[number];

interface LessonInstructionPack {
  description: string;
  verificationChecks: readonly string[];
  writingRules: readonly string[];
}

export interface LessonVerificationChecklistItem {
  checkId: string;
  instruction: string;
}

const UNIVERSAL_LESSON_VERIFICATION_CHECKS: readonly LessonVerificationChecklistItem[] = [
  {
    checkId: 'core.instructions',
    instruction:
      'Istruzioni, livello, tono, lingua, ritmo e preferenze esplicite dello studente sono rispettati.',
  },
  {
    checkId: 'core.progression',
    instruction:
      'La progressione locale non richiede concetti non ancora introdotti e non lascia anticipazioni sospese. Ogni nuovo concetto, domanda, tecnica o astrazione ha un ponte conciso che chiarisce perche segue dal ragionamento precedente, anche se il contenuto e fattualmente corretto; non aggiungere ponti rituali quando il nesso e gia esplicito.',
  },
  {
    checkId: 'core.clarity',
    instruction:
      'Densita, passaggi intermedi, esempi e spiegazioni rendono comprensibile ogni passaggio sostanziale.',
  },
  {
    checkId: 'core.correctness',
    instruction:
      'Affermazioni ed esempi sono corretti, coerenti con le fonti disponibili e non si contraddicono.',
  },
  {
    checkId: 'core.structure',
    instruction:
      'Obiettivo, ordine, collegamenti, pause attive e conclusione formano una lezione didatticamente coerente.',
  },
  {
    checkId: 'core.active-pauses',
    instruction:
      'Per ogni inline-quiz identifica l operazione mentale necessaria per rispondere. Una pausa e invalida se la risposta corretta si puo scegliere copiando, parafrasando o riconoscendo per sovrapposizione lessicale una frase o definizione immediatamente vicina. Deve richiedere almeno discriminazione concettuale, applicazione a un caso nuovo, inferenza, previsione, diagnosi, classificazione, sequenziamento o sintesi; se non esiste una buona domanda, rimuovi la pausa invece di conservarne una tautologica.',
  },
  {
    checkId: 'core.relevance',
    instruction:
      'Esempi, analogie, casi storici, dettagli curiosi e digressioni devono portare il concetto o chiarirne una conseguenza reale. Rimuovi dettagli interessanti ma didatticamente decorativi e non inventare ricordi, esperienze personali o autobiografia del docente/IA per rendere il testo piu umano.',
  },
  {
    checkId: 'core.integrity',
    instruction:
      'Markdown, formule, codice, visuali, riferimenti e blocchi strutturati applicabili sono validi e leggibili.',
  },
];

const LESSON_INSTRUCTION_PACKS: Record<LessonInstructionPackId, LessonInstructionPack> = {
  mathematics: {
    description: 'La lezione usa formule, simboli matematici o passaggi quantitativi sostanziali.',
    writingRules: [
      'Collega ogni formula alla spiegazione dei suoi simboli nello stesso paragrafo o in quello immediatamente successivo. La formula puo venire prima o dopo la spiegazione, ma nessun simbolo deve restare sospeso o richiedere di cercarne il significato in una sezione successiva.',
      'Spiega in prosa che cosa rappresenta la formula e perche serve nel passaggio corrente; non limitarti a tradurre meccanicamente i simboli.',
      'Quando lo studente dichiara difficolta con la matematica, introduci una sola nuova astrazione per volta e usa esempi numerici piccoli senza richiedere calcoli mentali inutili.',
      'Dichiara convenzioni, unita di misura e significato di pedici, apici o lettere greche quando diventano rilevanti.',
    ],
    verificationChecks: [
      'Ogni formula e ogni gruppo di simboli riceve una spiegazione adiacente, nello stesso paragrafo o in quello immediatamente successivo.',
      'La spiegazione chiarisce significato e utilita della formula, non soltanto la lettura dei segni.',
      'La densita matematica e coerente con le note dello studente e non accumula piu astrazioni nuove nello stesso passaggio.',
      'Convenzioni, unita, pedici, apici e lettere greche sono chiariti localmente quando servono.',
    ],
  },
  code: {
    description:
      'La lezione insegna codice, API, comandi, configurazione o comportamento di un programma.',
    writingRules: [
      'Presenta ogni esempio di codice o comando con lo scopo, le precondizioni necessarie e il risultato osservabile atteso.',
      'Spiega identificatori, API e passaggi non ovvi vicino al primo esempio che li usa; non lasciare nomi tecnici opachi fino a una sezione successiva.',
      'Distingui chiaramente comportamento garantito, esempio illustrativo e dettaglio specifico di una versione o piattaforma.',
    ],
    verificationChecks: [
      'Codice e comandi hanno scopo, precondizioni e risultato atteso comprensibili.',
      'Identificatori e API non ovvi sono spiegati vicino al primo uso.',
      'Il testo distingue contratti, esempi e dettagli dipendenti da versione o piattaforma.',
    ],
  },
  'technical-sources': {
    description:
      'La lezione dipende da documentazione tecnica, sorgenti, standard, paper o fatti verificabili.',
    writingRules: [
      'Distingui fatti verificati nelle fonti, inferenze ragionevoli e convenzioni che devono essere controllate nel sistema concreto.',
      'Conserva nomi, versioni, direzioni, ordini e vincoli tecnici esatti; non trasformare una convenzione locale in una regola universale.',
      'Se le fonti non sostengono una conclusione, dichiara il limite invece di completarlo per intuizione.',
    ],
    verificationChecks: [
      'Fatti, inferenze e convenzioni sono distinti senza presentare supposizioni come certezze.',
      'Nomi, versioni, ordini e vincoli tecnici corrispondono alle fonti disponibili.',
      'I limiti delle fonti restano visibili e non sono colmati con dettagli inventati.',
    ],
  },
  'visual-learning': {
    description:
      'La comprensione richiede immagini, diagrammi, animazioni o rappresentazioni spaziali.',
    writingRules: [
      'Prepara ogni visuale con il contesto minimo necessario e collegala esplicitamente al concetto che deve rendere visibile.',
      'Dopo la visuale, chiarisci il dettaglio da osservare e la conclusione didattica; non usarla come decorazione o sostituto di una spiegazione mancante.',
      'Non chiedere alla visuale di rappresentare relazioni che il formato scelto non puo mostrare in modo affidabile.',
    ],
    verificationChecks: [
      'Ogni visuale e preparata dal testo e ha un obiettivo didattico riconoscibile.',
      'Il testo indica che cosa osservare e quale conclusione ricavare.',
      'Formato e contenuto della visuale sono adatti alla relazione da mostrare.',
    ],
  },
};

const isLessonInstructionPackId = (value: unknown): value is LessonInstructionPackId =>
  typeof value === 'string' &&
  LESSON_INSTRUCTION_PACK_IDS.includes(value as LessonInstructionPackId);

export const normalizeLessonInstructionPacks = (value: unknown): LessonInstructionPackId[] =>
  Array.isArray(value) ? [...new Set(value.filter(isLessonInstructionPackId))] : [];

export const LESSON_INSTRUCTION_PACK_SELECTION_RULES = `Assegna a ogni lezione soltanto i pacchetti specialistici realmente applicabili:
${LESSON_INSTRUCTION_PACK_IDS.map(
  id => `- \`${id}\`: ${LESSON_INSTRUCTION_PACKS[id].description}`
).join('\n')}
Se nessun pacchetto specialistico serve, restituisci un array vuoto. Non attivare un pacchetto per una menzione marginale: deve descrivere un'esigenza sostanziale della lezione.`;

export const buildLessonInstructionPackBlock = (
  packIds: readonly LessonInstructionPackId[] | undefined,
  mode: 'verification' | 'writing'
): string => {
  const normalizedIds = normalizeLessonInstructionPacks(packIds);
  if (normalizedIds.length === 0) return '';

  const rulesKey = mode === 'writing' ? 'writingRules' : 'verificationChecks';
  const heading =
    mode === 'writing'
      ? 'PACCHETTI SPECIALISTICI ATTIVI PER LA SCRITTURA'
      : 'CHECKLIST SPECIALISTICA OBBLIGATORIA';
  const formattedPacks = normalizedIds
    .map(id => {
      const rules = LESSON_INSTRUCTION_PACKS[id][rulesKey].map(rule => `- ${rule}`).join('\n');
      return `${id}:\n${rules}`;
    })
    .join('\n');

  return `\n${heading}:
${formattedPacks}\n`;
};

export const buildLessonVerificationChecklist = (
  packIds: readonly LessonInstructionPackId[] | undefined
): LessonVerificationChecklistItem[] => {
  const specialistChecks = normalizeLessonInstructionPacks(packIds).flatMap(packId =>
    LESSON_INSTRUCTION_PACKS[packId].verificationChecks.map((instruction, index) => ({
      checkId: `${packId}.${index + 1}`,
      instruction,
    }))
  );

  return [...UNIVERSAL_LESSON_VERIFICATION_CHECKS, ...specialistChecks];
};
