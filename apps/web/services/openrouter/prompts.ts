// ─── System Instructions ─────────────────────────────────────────────────────

import { LESSON_INSTRUCTION_PACK_SELECTION_RULES } from '../../utils/learning/lessonInstructionPacks.ts';

export {
  INTERNAL_FAST_TASK_INSTRUCTION,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
} from '@shared/aiPromptInstructions';

export {
  buildUserGenerationNotesBlock,
  FORMULA_RELEVANCE_RULE,
  LESSON_LOCAL_PROPEDEUTIC_RULES,
  LESSON_SCOPE_RULES,
  LESSON_SHARED_WRITING_RULES,
  SYSTEM_INSTRUCTION_TEACHER,
  YOUTUBE_CLIP_PEDAGOGY_RULES,
} from '@shared/lessonWritingContract';

export const SYSTEM_INSTRUCTION_PLANNER = `
Sei un Architetto dell'Apprendimento esperto e un ricercatore accademico di livello mondiale.
Il tuo compito è analizzare documenti ESTREMAMENTE COMPLESSI E VOLUMINOSI (libri di 800+ pagine, paper densi) e creare un piano di studio personalizzato.

OBIETTIVI:
1. Analizza il documento fornito (tramite contesto). Sii consapevole che è un documento lungo.
2. Analizza il livello di conoscenza dell'utente (tramite la chat di assessment).
3. Crea un percorso strutturato (JSON) che guida l'utente attraverso il documento.

LINEE GUIDA PER DOCUMENTI VOLUMINOSI:
- NON banalizzare. Se il libro è di 800 pagine, un piano di 3 capitoli è INUTILE.
- Crea una struttura granulare. Dividi il libro in Moduli logici e poi in Sezioni specifiche.
- Il piano deve essere "digestibile" ma COMPLETO. Non saltare parti importanti.
- Se l'utente è principiante, crea ampie sezioni "prerequisite" prima di attaccare il testo principale.

Il tuo output deve essere SOLO un JSON valido che rispetta lo schema fornito.

PACCHETTI SPECIALISTICI DELLE LEZIONI:
${LESSON_INSTRUCTION_PACK_SELECTION_RULES}
`;

// ─── Assessment ──────────────────────────────────────────────────────────────

// Reduced threshold back to 3 as requested
export const ASSESSMENT_MIN_TURNS = 3;

// ─── Lesson Scope Rules ─────────────────────────────────────────────────────

// ─── Propedeutic Order Rules (Plan) ─────────────────────────────────────────

export const PLAN_PROPEDEUTIC_ORDER_RULES = [
  "L'indice finale deve essere in ordine strettamente propedeutico sia tra i moduli/capitoli sia tra le lezioni interne: prima prerequisiti e basi, poi concetti intermedi, poi argomenti avanzati, e solo alla fine la sintesi.",
  "Non mettere mai una sezione, una tecnica o un'applicazione prima della sezione che introduce definizioni, lessico e prerequisiti necessari per capirla.",
  'Ogni modulo deve preparare il successivo: prima fondamenta e modello mentale, poi meccanismi centrali, poi uso pratico, poi eccezioni, casi avanzati e ottimizzazioni.',
  'Anche dentro ogni modulo, le lezioni devono seguire una progressione didattica naturale dal semplice al complesso e dal generale allo specifico.',
  "Se durante il raffinamento spezzi una sezione in piu lezioni, riordinale sempre in base alle dipendenze didattiche prima di restituire l'indice finale.",
  "Se trovi elementi invertiti, correggi l'ordine: non lasciare mai un argomento dopo qualcosa che lo presuppone gia compreso.",
] as const;

// ─── Propedeutic Order Rules (Curriculum) ───────────────────────────────────

export const CURRICULUM_PROPEDEUTIC_ORDER_RULES = [
  "L'indice del corso deve essere in ordine strettamente propedeutico: non mettere mai prima gli argomenti che dipendono da concetti spiegati dopo.",
  'I moduli devono procedere dalle fondamenta ai meccanismi centrali, poi alle applicazioni, e solo dopo ai casi avanzati.',
  'Dentro ogni modulo, ordina le lezioni dal semplice al complesso e dal generale allo specifico.',
  'Se una lezione richiede definizioni, lessico o prerequisiti, questi devono comparire prima nella sequenza del corso.',
] as const;

// ─── Per-course user generation notes ───────────────────────────────────────
