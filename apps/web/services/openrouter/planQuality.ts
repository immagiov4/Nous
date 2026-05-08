import { decodeTextBase64, detectStoredSourceFileKind } from '../projects/projectSource.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import type { FileData, LearningPlan, LearningSection } from './types.ts';

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

export const resolvePlanningSourceProfile = async (
  file: FileData
): Promise<PlanningSourceProfile> => {
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
  sections: LearningSection[],
  sourceProfile?: Pick<PlanningSourceProfile, 'sizeTier'>
): LearningSection[] => {
  if (sections.length < 2) {
    return sections;
  }

  const exactDeduped: LearningSection[] = [];

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

  const compactDeduped: LearningSection[] = [];

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
