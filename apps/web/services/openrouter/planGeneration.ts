import { MEDIUM_REASONING_CONFIG } from './config.ts';
import { buildReasoningContentForFile } from './pdfReasoning.ts';
import {
  buildAdaptivePlanGuidance,
  dedupeLearningPlanSections,
  type PlanningSourceProfile,
  resolvePlanningSourceProfile,
} from './planQuality.ts';
import { PLAN_PROPEDEUTIC_ORDER_RULES } from './prompts.ts';
import {
  buildAssessmentSummary,
  callOpenRouter,
  type FileData,
  type LearningPlan,
  type LearningSection,
  type Message,
  MODEL_REASONING,
  parseCleanJson,
  plannerInstruction,
  retryWithBackoff,
} from './shared.ts';

const MAX_PLAN_SOURCE_CHARS = 180_000;

interface LearningPlanSectionDraft {
  id?: string;
  moduleTitle?: string;
  title?: string;
  description?: string;
  type?: LearningSection['type'];
  isCompleted?: boolean;
}

interface LearningPlanDraft {
  title?: string;
  summary?: string;
  sections?: LearningPlanSectionDraft[];
}

const normalizeLearningPlan = (
  plan: LearningPlanDraft,
  sourceProfile?: Pick<PlanningSourceProfile, 'sizeTier'>
): LearningPlan => {
  const sections = Array.isArray(plan.sections) ? plan.sections : [];
  const normalizedSections = sections
    .map((section, index) => ({
      id: `section-${index + 1}`,
      moduleTitle: (section.moduleTitle || '').trim() || undefined,
      title: (section.title || '').trim(),
      description: (section.description || '').trim(),
      type:
        section.type === 'prerequisite' ||
        section.type === 'core' ||
        section.type === 'summary' ||
        section.type === 'deep-dive'
          ? section.type
          : 'core',
      isCompleted: false,
    }))
    .filter(section => section.title && section.description);
  const dedupedSections = dedupeLearningPlanSections(normalizedSections, sourceProfile).map(
    (section, index) => ({
      ...section,
      id: `section-${index + 1}`,
    })
  );

  return {
    title: (plan.title || 'Percorso di studio').trim(),
    summary: (plan.summary || '').trim(),
    sections: dedupedSections,
  };
};

const runInitialLearningPlan = async (
  file: FileData,
  assessmentSummary: string,
  sourceProfile: PlanningSourceProfile
): Promise<LearningPlan> => {
  const planGuidance = buildAdaptivePlanGuidance(sourceProfile);
  const prompt = `Analizza il documento allegato.
Ecco il contesto dell'utente (Assessment):
${assessmentSummary}

Crea un piano di studi dettagliato e calibrato sulla reale quantita di materiale.
- Se l'utente e principiante, aggiungi sezioni 'prerequisite' solo quando servono davvero a capire il testo.
- Raggruppa le sezioni in moduli logici coerenti tramite moduleTitle, ma non inventare moduli se il materiale e troppo breve per sostenerli.
${planGuidance}
- Considera come materiale didattico anche tabelle, blocchi comparativi, grafici con label testuali, didascalie e schemi descritti nel testo: non ignorarli se contengono informazione sostanziale.
- Ogni lezione deve coprire un solo concetto, passaggio sperimentale, meccanismo o sottosistema davvero distinto.
- Ogni description deve spiegare COSA si imparera e delimitare chiaramente lo scope della lezione, cosi da evitare sovrapposizioni con altre lezioni.
- Non creare lezioni separate per semplici parafrasi, esempi aggiuntivi, ripetizioni o ricapitolazioni dello stesso nucleo concettuale.
- Prima di restituire l'indice, esegui una deduplica esplicita: se due lezioni condividono quasi lo stesso materiale sorgente o possono essere spiegate con la stessa lezione, fondile.
- Assicurati che i titoli siano descrittivi.
- Vincoli di ordine propedeutico:
${PLAN_PROPEDEUTIC_ORDER_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "title": "Titolo generale del percorso",
  "summary": "Breve panoramica motivazionale",
  "sections": [
    {
      "id": "unique-id",
      "moduleTitle": "Titolo del modulo",
      "title": "Titolo sezione",
      "description": "Cosa si impara",
      "type": "prerequisite|core|summary",
      "isCompleted": false
    }
  ]
}`;

  const userContent = await buildReasoningContentForFile(file, prompt, MAX_PLAN_SOURCE_CHARS);

  const response = await callOpenRouter({
    model: MODEL_REASONING,
    reasoning: MEDIUM_REASONING_CONFIG,
    messages: [
      { role: 'system', content: plannerInstruction },
      {
        role: 'user',
        content: userContent,
      },
    ],
    response_format: { type: 'json_object' },
  });

  if (!response) {
    throw new Error('No plan generated');
  }

  return normalizeLearningPlan(parseCleanJson<LearningPlanDraft>(response), sourceProfile);
};

const runRefinedLearningPlan = async (
  file: FileData,
  assessmentSummary: string,
  draftPlan: LearningPlan,
  sourceProfile: PlanningSourceProfile
): Promise<LearningPlan> => {
  const planGuidance = buildAdaptivePlanGuidance(sourceProfile);
  const prompt = `Sei un curriculum refiner. Hai gia un primo indice e devi renderlo preciso, non necessariamente piu lungo.

CONTESTO UTENTE:
${assessmentSummary}

INDICE DA RAFFINARE:
${JSON.stringify(draftPlan, null, 2)}

Compito:
- Raffina questo indice fino al giusto livello di granularita rispetto al materiale sorgente.
${planGuidance}
- Se il materiale contiene tabelle, confronti strutturati o grafici descritti testualmente, assicurati che entrino esplicitamente nel percorso e non restino fuori dall'indice solo perche non sono prosa lineare.
- Spezza una sezione solo se il materiale contiene davvero sotto-argomenti distinti, ciascuno con esempi, evidenze o passaggi propri.
- Se due lezioni risultano vicine, sovrapposte o distinguibili solo per formulazione, fondile in una sola lezione piu netta.
- Se il documento ruota attorno a una sola idea centrale o a un unico flusso sperimentale, puoi lasciare anche una sola lezione.
- Ogni lezione deve avere un focus netto e insegnabile.
- Ogni description deve chiarire cosa appartiene a quella lezione e, quando serve a evitare overlap, cosa NON va sviluppato li.
- Evita titoli generici o riassuntivi quando il testo consente una divisione piu fine, ma non frammentare un argomento unico in pseudo-sottolezioni ridondanti.
- Non creare lezioni duplicate, sovrapposte o finali di sintesi che ripetano semplicemente l'ultima lezione.
- Prima di restituire l'indice finale, controlla e correggi eventuali inversioni di prerequisiti tra moduli e tra lezioni nello stesso modulo.
- Vincoli di ordine propedeutico:
${PLAN_PROPEDEUTIC_ORDER_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "title": "Titolo generale del percorso",
  "summary": "Breve panoramica motivazionale",
  "sections": [
    {
      "id": "unique-id",
      "moduleTitle": "Titolo del modulo",
      "title": "Titolo sezione",
      "description": "Cosa si impara",
      "type": "prerequisite|core|summary",
      "isCompleted": false
    }
  ]
}`;

  const userContent = await buildReasoningContentForFile(file, prompt, MAX_PLAN_SOURCE_CHARS);

  const response = await callOpenRouter({
    model: MODEL_REASONING,
    reasoning: MEDIUM_REASONING_CONFIG,
    messages: [
      { role: 'system', content: plannerInstruction },
      {
        role: 'user',
        content: userContent,
      },
    ],
    response_format: { type: 'json_object' },
  });

  if (!response) {
    throw new Error('No refined plan generated');
  }

  return normalizeLearningPlan(parseCleanJson<LearningPlanDraft>(response), sourceProfile);
};

export const generateLearningPlan = async (
  file: FileData,
  assessmentHistory: Message[],
  onStatusUpdate?: (status: string) => void
): Promise<LearningPlan> => {
  const assessmentSummary = buildAssessmentSummary(assessmentHistory);
  const sourceProfile = await resolvePlanningSourceProfile(file);

  return retryWithBackoff(async () => {
    onStatusUpdate?.('Bozza indice...');
    const initialPlan = await runInitialLearningPlan(file, assessmentSummary, sourceProfile);
    onStatusUpdate?.(`Raffinamento indice... ${initialPlan.sections.length} lezioni iniziali`);
    const refinedPlan = await runRefinedLearningPlan(
      file,
      assessmentSummary,
      initialPlan,
      sourceProfile
    );
    onStatusUpdate?.(`Indice raffinato: ${refinedPlan.sections.length} lezioni`);
    return refinedPlan;
  });
};
