import { decodeTextBase64, detectStoredSourceFileKind } from '../projects/projectSource.ts';
import { MEDIUM_REASONING_CONFIG } from './config.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import { PLAN_PROPEDEUTIC_ORDER_RULES } from './prompts.ts';
import {
  buildAssessmentSummary,
  buildDocumentInputContent,
  callOpenRouter,
  type FileData,
  isPdfFile,
  type LearningPlan,
  type LearningSection,
  type Message,
  MODEL_REASONING,
  parseCleanJson,
  plannerInstruction,
  retryWithBackoff,
} from './shared.ts';

const MAX_PLAN_SOURCE_CHARS = 180_000;

const PDF_KEYWORD_STOP_WORDS = new Set([
  'about',
  'agli',
  'alla',
  'alle',
  'anche',
  'avere',
  'bene',
  'che',
  'come',
  'con',
  'core',
  'dall',
  'dalla',
  'dalle',
  'degli',
  'della',
  'delle',
  'dello',
  'dopo',
  'dove',
  'ecco',
  'fare',
  'figura',
  'figure',
  'from',
  'have',
  'into',
  'lesson',
  'lezione',
  'line',
  'nelle',
  'nella',
  'nelle',
  'nello',
  'niente',
  'only',
  'oppure',
  'over',
  'pero',
  'perche',
  'prima',
  'quale',
  'quali',
  'quando',
  'questa',
  'queste',
  'questi',
  'questo',
  'sara',
  'same',
  'section',
  'sempre',
  'senza',
  'sono',
  'solo',
  'sotto',
  'sugli',
  'sulla',
  'sulle',
  'that',
  'them',
  'they',
  'through',
  'titolo',
  'tutto',
  'with',
  'your',
]);

type PlanningSourceKind = 'pdf' | 'text' | 'other';
export type PlanningSourceSizeTier = 'tiny' | 'small' | 'medium' | 'large';

interface PlanningCountRange {
  min: number;
  max: number;
}

export interface PlanningSourceProfile {
  allowSingleLesson: boolean;
  extractedCharacterCount?: number;
  kind: PlanningSourceKind;
  lessonCount: PlanningCountRange;
  moduleCount: PlanningCountRange;
  pageCount?: number;
  sizeTier: PlanningSourceSizeTier;
  summaryLessonOptional: boolean;
}

interface PlanningSourceProfileSeed {
  extractedCharacterCount?: number;
  kind: PlanningSourceKind;
  pageCount?: number;
}

export const normalizeSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const getSearchKeywords = (text: string): string[] =>
  normalizeSearchText(text)
    .split(' ')
    .filter(word => word.length >= 4 && !PDF_KEYWORD_STOP_WORDS.has(word));

const PDF_SUBSTANTIVE_PAGE_COVERAGE_RATIO = 0.9;
const LARGE_PDF_SOFT_MIN_PAGES_PER_LESSON = 10;
const LARGE_PDF_SOFT_MAX_PAGES_PER_LESSON = 30;

const resolvePdfSourceSizeTier = (pageCount?: number): PlanningSourceSizeTier => {
  if (!pageCount || pageCount < 1) {
    return 'medium';
  }

  if (pageCount <= 6) {
    return 'tiny';
  }

  if (pageCount <= 16) {
    return 'small';
  }

  if (pageCount <= 60) {
    return 'medium';
  }

  return 'large';
};

const resolveTextSourceSizeTier = (characterCount?: number): PlanningSourceSizeTier => {
  if (!characterCount || characterCount < 1) {
    return 'medium';
  }

  if (characterCount <= 12_000) {
    return 'tiny';
  }

  if (characterCount <= 40_000) {
    return 'small';
  }

  if (characterCount <= 120_000) {
    return 'medium';
  }

  return 'large';
};

export const resolvePlanningSourceProfileFromSeed = ({
  extractedCharacterCount,
  kind,
  pageCount,
}: PlanningSourceProfileSeed): PlanningSourceProfile => {
  const sizeTier =
    kind === 'pdf'
      ? resolvePdfSourceSizeTier(pageCount)
      : kind === 'text'
        ? resolveTextSourceSizeTier(extractedCharacterCount)
        : 'medium';

  switch (sizeTier) {
    case 'tiny':
      return {
        allowSingleLesson: true,
        extractedCharacterCount,
        kind,
        lessonCount: { min: 1, max: 3 },
        moduleCount: { min: 1, max: 2 },
        pageCount,
        sizeTier,
        summaryLessonOptional: true,
      };
    case 'small':
      return {
        allowSingleLesson: true,
        extractedCharacterCount,
        kind,
        lessonCount: { min: 2, max: 6 },
        moduleCount: { min: 1, max: 3 },
        pageCount,
        sizeTier,
        summaryLessonOptional: true,
      };
    case 'large':
      return {
        allowSingleLesson: false,
        extractedCharacterCount,
        kind,
        lessonCount: { min: 10, max: 30 },
        moduleCount: { min: 3, max: 6 },
        pageCount,
        sizeTier,
        summaryLessonOptional: false,
      };
    default:
      return {
        allowSingleLesson: false,
        extractedCharacterCount,
        kind,
        lessonCount: { min: 6, max: 12 },
        moduleCount: { min: 2, max: 5 },
        pageCount,
        sizeTier: 'medium',
        summaryLessonOptional: false,
      };
  }
};

const resolvePlanningSourceProfile = async (file: FileData): Promise<PlanningSourceProfile> => {
  const sourceKind = detectStoredSourceFileKind(file);

  if (sourceKind === 'pdf') {
    try {
      const pdfSession = await getPdfTextSession(file);
      return resolvePlanningSourceProfileFromSeed({
        extractedCharacterCount: pdfSession?.extractedText?.trim().length,
        kind: 'pdf',
        pageCount: pdfSession?.pageCount,
      });
    } catch (error) {
      console.warn('[Nous][Planning] Failed to profile PDF source size.', error);
      return resolvePlanningSourceProfileFromSeed({ kind: 'pdf' });
    }
  }

  if (sourceKind === 'text') {
    try {
      return resolvePlanningSourceProfileFromSeed({
        extractedCharacterCount: decodeTextBase64(file.data).trim().length,
        kind: 'text',
      });
    } catch (error) {
      console.warn('[Nous][Planning] Failed to profile text source size.', error);
      return resolvePlanningSourceProfileFromSeed({ kind: 'text' });
    }
  }

  return resolvePlanningSourceProfileFromSeed({ kind: 'other' });
};

const formatPlanningCountRange = (
  { max, min }: PlanningCountRange,
  singular: string,
  plural: string
) => (min === max ? `${min} ${min === 1 ? singular : plural}` : `${min}-${max} ${plural}`);

const formatPlanningSourceStats = (profile: PlanningSourceProfile): string => {
  if (profile.kind === 'pdf' && typeof profile.pageCount === 'number') {
    return `${profile.pageCount} pagine circa`;
  }

  if (profile.kind === 'text' && typeof profile.extractedCharacterCount === 'number') {
    return `${profile.extractedCharacterCount.toLocaleString('it-IT')} caratteri circa`;
  }

  return 'dimensione non stimabile con precisione';
};

const estimatePdfSubstantivePageCount = (pageCount: number): number =>
  Math.max(1, Math.round(pageCount * PDF_SUBSTANTIVE_PAGE_COVERAGE_RATIO));

const buildPdfPlanCoverageGuidance = (profile: PlanningSourceProfile): string[] => {
  if (profile.kind !== 'pdf' || typeof profile.pageCount !== 'number' || profile.pageCount < 1) {
    return [];
  }

  const substantivePageCount = estimatePdfSubstantivePageCount(profile.pageCount);
  const guidance = [
    `- Per i PDF, fai in modo che l'indice copra quasi tutto il contenuto sostanziale del libro: come ordine di grandezza, circa ${substantivePageCount} pagine su ${profile.pageCount}, lasciando fuori solo front matter, appendici o indici se davvero non didattici.`,
    "- Evita buchi di copertura: se nel mezzo del documento c'e un blocco consistente di pagine con contenuto tecnico nuovo, deve ricadere in qualche lezione o modulo.",
  ];

  if (profile.sizeTier === 'large') {
    guidance.push(
      `- Su PDF estesi usa come target morbido lezioni che coprano spesso circa ${LARGE_PDF_SOFT_MIN_PAGES_PER_LESSON}-${LARGE_PDF_SOFT_MAX_PAGES_PER_LESSON} pagine sostantive: evita sia macro-lezioni che comprimono 80-200 pagine in una sola volta, sia micro-lezioni da 1-3 pagine salvo casi davvero autonomi.`
    );
  } else if (profile.sizeTier === 'medium') {
    guidance.push(
      '- Mantieni una granularita coerente con la densita delle pagine: evita sia lezioni che comprimono blocchi troppo ampi sia lezioni microscopiche da poche pagine, salvo quando il testo cambia davvero argomento.'
    );
  }

  return guidance;
};

export const buildAdaptivePlanGuidance = (profile: PlanningSourceProfile): string => {
  const sizeLabel =
    profile.sizeTier === 'tiny'
      ? 'molto compatta'
      : profile.sizeTier === 'small'
        ? 'compatta'
        : profile.sizeTier === 'large'
          ? 'estesa'
          : 'intermedia';

  return [
    `- Calibra la granularita sull'effettiva dimensione della fonte: qui la fonte appare ${sizeLabel} (${formatPlanningSourceStats(profile)}).`,
    `- Range indicativo: ${formatPlanningCountRange(profile.moduleCount, 'modulo', 'moduli')} e ${formatPlanningCountRange(profile.lessonCount, 'lezione', 'lezioni')} totali, ma solo se il materiale lo sostiene davvero.`,
    ...buildPdfPlanCoverageGuidance(profile),
    profile.allowSingleLesson
      ? '- Se il materiale ruota attorno a un solo nucleo concettuale, una sola tesi forte o un unico flusso sperimentale, puoi restituire anche una sola lezione.'
      : '- Suddividi il materiale in piu lezioni solo quando i confini concettuali sono davvero distinti e sostenuti dal testo.',
    profile.summaryLessonOptional
      ? "- La sintesi finale e opzionale: aggiungila solo se porta una ricapitolazione trasversale nuova, non se ripete l'ultima lezione."
      : '- Mantieni al massimo una sola lezione finale di sintesi, chiaramente distinta dalle lezioni precedenti.',
    '- Crea una nuova lezione solo se puo avere materiale sorgente distinto, uno scope autonomo e un obiettivo didattico non sovrapposto.',
    '- Se due lezioni condividono quasi gli stessi concetti, esempi, risultati o passaggi del materiale, fondile invece di tenerle separate.',
  ].join('\n');
};

const PLAN_SECTION_SCOPE_OVERLAP_THRESHOLD = 0.72;
const PLAN_SECTION_TITLE_OVERLAP_THRESHOLD = 0.75;
const PLAN_SECTION_FALLBACK_SCOPE_THRESHOLD = 0.5;
const PLAN_SECTION_MIN_SHARED_KEYWORDS = 2;

const isCompactPlanningSource = (profile?: Pick<PlanningSourceProfile, 'sizeTier'>): boolean =>
  profile?.sizeTier === 'tiny' || profile?.sizeTier === 'small';

const buildPlanSectionScopeText = (
  section: Pick<LearningSection, 'moduleTitle' | 'title' | 'description'>
): string =>
  [section.moduleTitle || '', section.title, section.description].filter(Boolean).join(' ');

const computePlanKeywordOverlap = (leftText: string, rightText: string) => {
  const leftKeywords = Array.from(new Set(getSearchKeywords(leftText)));
  const rightKeywordSet = new Set(getSearchKeywords(rightText));
  const sharedKeywordCount = leftKeywords.filter(keyword => rightKeywordSet.has(keyword)).length;

  return {
    overlap: sharedKeywordCount / Math.max(1, Math.min(leftKeywords.length, rightKeywordSet.size)),
    sharedKeywordCount,
  };
};

const isPlanSectionNearDuplicate = (
  left: Pick<LearningSection, 'moduleTitle' | 'title' | 'description'>,
  right: Pick<LearningSection, 'moduleTitle' | 'title' | 'description'>
): boolean => {
  const normalizedLeftTitle = normalizeSearchText(left.title);
  const normalizedRightTitle = normalizeSearchText(right.title);
  if (!normalizedLeftTitle || !normalizedRightTitle) {
    return false;
  }

  if (normalizedLeftTitle === normalizedRightTitle) {
    return true;
  }

  const titleOverlap = computePlanKeywordOverlap(left.title, right.title);
  const scopeOverlap = computePlanKeywordOverlap(
    buildPlanSectionScopeText(left),
    buildPlanSectionScopeText(right)
  );
  const normalizedLeftModule = normalizeSearchText(left.moduleTitle || '');
  const normalizedRightModule = normalizeSearchText(right.moduleTitle || '');
  const sameModule =
    normalizedLeftModule.length > 0 && normalizedLeftModule === normalizedRightModule;
  const titleContains =
    normalizedLeftTitle.includes(normalizedRightTitle) ||
    normalizedRightTitle.includes(normalizedLeftTitle);

  if (
    sameModule &&
    titleContains &&
    scopeOverlap.sharedKeywordCount >= PLAN_SECTION_MIN_SHARED_KEYWORDS &&
    scopeOverlap.overlap >= PLAN_SECTION_FALLBACK_SCOPE_THRESHOLD
  ) {
    return true;
  }

  if (
    sameModule &&
    titleOverlap.overlap >= PLAN_SECTION_TITLE_OVERLAP_THRESHOLD &&
    scopeOverlap.overlap >= PLAN_SECTION_FALLBACK_SCOPE_THRESHOLD
  ) {
    return true;
  }

  return (
    scopeOverlap.sharedKeywordCount >= PLAN_SECTION_MIN_SHARED_KEYWORDS + 1 &&
    scopeOverlap.overlap >= PLAN_SECTION_SCOPE_OVERLAP_THRESHOLD
  );
};

const getPlanSectionSpecificityScore = (
  section: Pick<LearningSection, 'moduleTitle' | 'title' | 'description' | 'type'>
): number => {
  const keywordCount = getSearchKeywords(buildPlanSectionScopeText(section)).length;
  const summaryPenalty = section.type === 'summary' ? 18 : 0;
  const prerequisiteBonus = section.type === 'prerequisite' ? 6 : 0;

  return (
    keywordCount * 10 +
    section.description.trim().length +
    (section.moduleTitle ? 12 : 0) +
    prerequisiteBonus -
    summaryPenalty
  );
};

const pickPreferredPlanSection = (
  left: LearningSection,
  right: LearningSection
): LearningSection => {
  if (left.type === 'summary' && right.type !== 'summary') {
    return { ...right, moduleTitle: right.moduleTitle || left.moduleTitle };
  }

  if (right.type === 'summary' && left.type !== 'summary') {
    return { ...left, moduleTitle: left.moduleTitle || right.moduleTitle };
  }

  const rightWins = getPlanSectionSpecificityScore(right) > getPlanSectionSpecificityScore(left);
  const preferred = rightWins ? right : left;
  const alternate = rightWins ? left : right;
  return {
    ...preferred,
    moduleTitle: preferred.moduleTitle || alternate.moduleTitle,
  };
};

export const dedupeLearningPlanSections = (
  sections: LearningPlan['sections'],
  sourceProfile?: Pick<PlanningSourceProfile, 'sizeTier'>
): LearningPlan['sections'] => {
  if (sections.length < 2) {
    return sections;
  }

  const exactDeduped: LearningPlan['sections'] = [];

  sections.forEach(section => {
    const duplicateIndex = exactDeduped.findIndex(existing => {
      const sameTitle = normalizeSearchText(existing.title) === normalizeSearchText(section.title);
      const sameDescription =
        normalizeSearchText(existing.description) === normalizeSearchText(section.description);
      return sameTitle && sameDescription;
    });

    if (duplicateIndex >= 0) {
      exactDeduped[duplicateIndex] = pickPreferredPlanSection(
        exactDeduped[duplicateIndex],
        section
      );
      return;
    }

    exactDeduped.push(section);
  });

  if (!isCompactPlanningSource(sourceProfile)) {
    return exactDeduped;
  }

  const compactDeduped: LearningPlan['sections'] = [];

  exactDeduped.forEach(section => {
    const previous = compactDeduped[compactDeduped.length - 1];
    if (previous && isPlanSectionNearDuplicate(previous, section)) {
      compactDeduped[compactDeduped.length - 1] = pickPreferredPlanSection(previous, section);
      return;
    }

    compactDeduped.push(section);
  });

  if (compactDeduped.length === 2) {
    const [firstSection, lastSection] = compactDeduped;
    if (lastSection.type === 'summary' && isPlanSectionNearDuplicate(firstSection, lastSection)) {
      return [firstSection];
    }
  }

  return compactDeduped;
};

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

export const clipPdfSourceText = (text: string, maxChars: number): string => {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n\n[ESTRATTO PDF TRONCATO PER LIMITI DI CONTESTO]`;
};

export const buildPdfReasoningExtractionNotes = (
  pdfSession:
    | {
        parser?: 'pdftotext' | 'pdf-parse';
        pageCount?: number;
      }
    | null
    | undefined
): string => {
  const notes = [
    pdfSession?.parser === 'pdftotext'
      ? '- Il testo e stato estratto con pdftotext in modalita layout-preserving: se trovi blocchi allineati, colonne o valori ripetuti per riga, trattali come possibili tabelle.'
      : pdfSession?.parser === 'pdf-parse'
        ? '- Il testo e stato estratto con pdf-parse: i blocchi tabellari possono risultare piu piatti o riordinati. Se noti pattern tabellari, trattali come tabelle solo quando il testo lo supporta chiaramente.'
        : '- Il testo del PDF puo perdere parte del layout originario: non ignorare blocchi tabellari o confronti solo perche appaiono meno puliti del documento visivo.',
    '- Considera come contenuto sostanziale anche tabelle, blocchi comparativi, matrici, didascalie, legende, assi e label testuali di grafici o schemi quando compaiono nel testo estratto.',
  ];

  if (typeof pdfSession?.pageCount === 'number' && pdfSession.pageCount > 0) {
    notes.unshift(`- Il PDF contiene circa ${pdfSession.pageCount} pagine.`);
  }

  return notes.join('\n');
};

export const buildReasoningContentForFile = async (
  file: FileData,
  prompt: string,
  maxPdfChars: number
) => {
  if (!isPdfFile(file)) {
    return buildDocumentInputContent(file, prompt);
  }

  try {
    const pdfSession = await getPdfTextSession(file);
    const extractedText = pdfSession?.extractedText?.trim() || '';

    if (extractedText) {
      return `Documento: ${file.name}

${prompt}

NOTE DI ESTRAZIONE PDF:
${buildPdfReasoningExtractionNotes(pdfSession)}

TESTO ESTRATTO DAL PDF:
${clipPdfSourceText(extractedText, maxPdfChars)}`;
    }
  } catch (error) {
    console.warn('[Nous][Planning] PDF text extraction failed for reasoning prompt.', error);
  }

  return `Documento: ${file.name}

${prompt}

Nota importante: non e stato possibile estrarre il testo del PDF in modo affidabile.
Non presumere dettagli non supportati e non affermare di aver letto il file se il contenuto non e presente nel prompt.`;
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
