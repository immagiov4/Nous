import {
  ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE,
  normalizeActivePauseExerciseType,
} from '../../utils/learning/activePause.ts';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
import { pushNousDebugTrace } from '../core/debugTrace.ts';
import { decodeTextBase64, detectStoredSourceFileKind } from '../projects/projectSource.ts';
import { HIGH_REASONING_CONFIG } from './config.ts';
import { buildReasoningContentForFile, clipPdfSourceText } from './contextChat.ts';
import {
  buildLessonChunkContext,
  buildPdfPageTextLayout,
  resolveLessonContextChunks,
  resolvePdfChunkPageSpan,
} from './documentIndex.ts';
import {
  buildStoredPdfDocumentAssets,
  getPdfAssetSession,
  getPdfTextSession,
} from './pdfAssets.ts';
import {
  buildUserGenerationNotesBlock,
  LESSON_SCOPE_RULES,
  PLAN_PROPEDEUTIC_ORDER_RULES,
} from './prompts.ts';
import {
  buildAssessmentSummary,
  callOpenRouter,
  type FileData,
  isPdfFile,
  type LearningPlan,
  type LearningSection,
  type LessonImageRef,
  type Message,
  MODEL_FLASH,
  MODEL_REASONING,
  type PdfDocumentAssets,
  type PdfTextChunk,
  type PdfTextIndex,
  parseCleanJson,
  plannerInstruction,
  type QuizQuestion,
  retryWithBackoff,
  teacherInstruction,
  type UserProfile,
} from './shared.ts';

const MIN_FALLBACK_IMAGE_SCORE = 2;
const PDF_PLACEHOLDER_PREFIX = '{{PDF_IMAGE:';
const MAX_PLAN_SOURCE_CHARS = 180_000;
const MAX_METADATA_SOURCE_CHARS = 32_000;
const MAX_PDF_FALLBACK_LESSON_SOURCE_CHARS = 36_000;
const MAX_LESSON_REPAIR_SOURCE_CHARS = 24_000;
const PDF_ASSET_SESSION_TIMEOUT_MS = 20_000;
const PDF_IMAGE_PAGE_RADIUS = 2;
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
interface SectionImagePlacement {
  assetId: string;
  alt: string;
  caption?: string | null;
  anchorHeading?: string | null;
}

interface PdfSectionContentPayload {
  contentMarkdown?: string;
  quiz?: QuizQuestion[];
  imagePlacements?: SectionImagePlacement[];
}

interface LessonVerificationDraft {
  contentMarkdown: string;
  quiz: QuizQuestion[];
  imagePlacements: LessonImageRef[];
}

class SoftTimeoutError extends Error {
  timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'SoftTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const LESSON_MARKDOWN_TRACE_PREVIEW_CHARS = 1600;

const summarizeLessonMarkdownForTrace = (content: string) => ({
  hasCodeFence: /(^|\n)```/.test(content),
  length: content.length,
  preview: content.slice(0, LESSON_MARKDOWN_TRACE_PREVIEW_CHARS),
});

const withSoftTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise.then(
        value => value,
        error => {
          throw error;
        }
      ),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new SoftTimeoutError(`Operation exceeded soft timeout of ${timeoutMs}ms.`, timeoutMs)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const isSoftTimeoutError = (error: unknown): error is SoftTimeoutError =>
  error instanceof SoftTimeoutError;

const traceLessonMarkdownStage = (
  stage: 'cleaned' | 'raw' | 'repaired' | 'verified',
  sectionTitle: string,
  content: string
) => {
  pushNousDebugTrace(`lesson-markdown:${stage}`, {
    sectionTitle,
    ...summarizeLessonMarkdownForTrace(content),
  });
};

export { LESSON_SCOPE_RULES, PLAN_PROPEDEUTIC_ORDER_RULES };

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

const PDF_SUBSTANTIVE_PAGE_COVERAGE_RATIO = 0.9;
const LARGE_PDF_SOFT_MIN_PAGES_PER_LESSON = 10;
const LARGE_PDF_SOFT_MAX_PAGES_PER_LESSON = 30;

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

const MIN_LESSON_QUIZ_QUESTIONS = 1;
const MAX_LESSON_QUIZ_QUESTIONS = 3;
const LESSON_QUIZ_OPTION_COUNT = 4;
const ACTIVE_PAUSE_EXERCISE_TYPE_RULES = ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(
  exercise => `- ${exercise.type}: ${exercise.instruction}`
).join('\n');

const clampLessonQuizCount = (value: number): number =>
  Math.max(MIN_LESSON_QUIZ_QUESTIONS, Math.min(MAX_LESSON_QUIZ_QUESTIONS, value));

const buildLessonResponseSchema = (exactQuizCount?: number) => {
  const quizCount =
    typeof exactQuizCount === 'number' && Number.isInteger(exactQuizCount)
      ? clampLessonQuizCount(exactQuizCount)
      : undefined;

  return {
    name: 'nous_lesson_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contentMarkdown: {
          type: 'string',
        },
        quiz: {
          type: 'array',
          minItems: quizCount ?? MIN_LESSON_QUIZ_QUESTIONS,
          maxItems: quizCount ?? MAX_LESSON_QUIZ_QUESTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              exerciseType: {
                type: 'string',
                enum: ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(exercise => exercise.type),
              },
              question: {
                type: 'string',
              },
              options: {
                type: 'array',
                minItems: LESSON_QUIZ_OPTION_COUNT,
                maxItems: LESSON_QUIZ_OPTION_COUNT,
                items: {
                  type: 'string',
                },
              },
              correctIndex: {
                type: 'integer',
                minimum: 0,
                maximum: LESSON_QUIZ_OPTION_COUNT - 1,
              },
            },
            required: ['exerciseType', 'question', 'options', 'correctIndex'],
          },
        },
        imagePlacements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assetId: {
                type: 'string',
              },
              alt: {
                type: 'string',
              },
              caption: {
                type: ['string', 'null'],
              },
              anchorHeading: {
                type: ['string', 'null'],
              },
            },
            required: ['assetId', 'alt', 'caption', 'anchorHeading'],
          },
        },
      },
      required: ['contentMarkdown', 'quiz', 'imagePlacements'],
    },
  } as const;
};

export const LESSON_RESPONSE_SCHEMA = buildLessonResponseSchema();

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

const PLAN_SECTION_SCOPE_OVERLAP_THRESHOLD = 0.72;
const PLAN_SECTION_TITLE_OVERLAP_THRESHOLD = 0.75;
const PLAN_SECTION_FALLBACK_SCOPE_THRESHOLD = 0.5;
const PLAN_SECTION_MIN_SHARED_KEYWORDS = 2;

const logPdfLessonDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Nous][PDF Lesson] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

const normalizeSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

const getSearchKeywords = (text: string): string[] =>
  normalizeSearchText(text)
    .split(' ')
    .filter(word => word.length >= 4 && !PDF_KEYWORD_STOP_WORDS.has(word));

const getPdfImageSearchText = (image: PdfDocumentAssets['usedImages'][number]): string =>
  [image.caption || '', image.textBefore, image.textCurrent || '', image.textAfter]
    .filter(Boolean)
    .join(' ');

const scorePageProximity = (pageNumber: number | undefined, targetedPages: number[]): number => {
  if (!Number.isInteger(pageNumber) || targetedPages.length === 0) {
    return 0;
  }

  const centerPage = (targetedPages[0] + targetedPages[targetedPages.length - 1]) / 2;
  const distance = Math.abs((pageNumber as number) - centerPage);
  if (distance <= 0.5) {
    return 4;
  }

  if (distance <= 1.5) {
    return 3;
  }

  if (distance <= 2.5) {
    return 2;
  }

  if (distance <= 3.5) {
    return 1;
  }

  return 0;
};

const selectCandidatePdfImages = (
  images: PdfDocumentAssets['usedImages'],
  sectionTitle: string,
  sectionDescription: string,
  targetedPages: number[] = []
) => {
  const visuallyClearImages = images.filter(image => Boolean(image.caption?.trim()));
  if (visuallyClearImages.length === 0) {
    return [];
  }

  const keywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const scored = visuallyClearImages
    .map(image => {
      const haystack = normalizeSearchText(getPdfImageSearchText(image));
      const keywordScore = scoreKeywordHits(haystack, keywords);
      const pageScore = scorePageProximity(image.pageNumber, targetedPages);
      const score = keywordScore * 3 + pageScore;
      return { image, score };
    })
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    );

  const relevant = scored.filter(item => item.score > 0).map(item => item.image);
  if (relevant.length > 0) {
    return relevant;
  }

  // Use only figures that the vision pass considered clear enough to describe.
  return scored.map(item => item.image);
};

const scoreKeywordHits = (haystack: string, keywords: Iterable<string>): number =>
  Array.from(keywords).reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);

const getMarkdownHeadings = (contentMarkdown: string): string[] =>
  contentMarkdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(#{1,6})\s+/.test(line))
    .map(line => line.replace(/^(#{1,6})\s+/, '').trim())
    .filter(Boolean);

const buildImageContextSummary = (
  image: PdfDocumentAssets['usedImages'][number],
  sectionTitle: string,
  sectionDescription: string
): string => {
  const joinedContext = getPdfImageSearchText(image).trim();
  const normalized = joinedContext.replace(/\s+/g, ' ').trim();
  const sentenceCandidates = normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const sectionKeywords = getSearchKeywords(`${sectionTitle} ${sectionDescription}`);
  const bestSentence = sentenceCandidates
    .map(sentence => ({
      sentence,
      score: scoreKeywordHits(normalizeSearchText(sentence), sectionKeywords),
    }))
    .sort((left, right) => right.score - left.score)[0]?.sentence;

  const chosen =
    image.caption?.trim() || bestSentence || sentenceCandidates[0] || normalized || sectionTitle;
  const compact = chosen
    .replace(/^[:;,\-\s]+/, '')
    .replace(/[|}]/g, ' ')
    .trim();

  return compact.length > 140 ? `${compact.slice(0, 137).trim()}...` : compact;
};

const buildVisibleImageLabel = (
  image: PdfDocumentAssets['usedImages'][number],
  sectionTitle: string,
  sectionDescription: string
): string => {
  const summary = buildImageContextSummary(image, sectionTitle, sectionDescription)
    .replace(/^(la|il|lo|i|gli|le|una|un|uno)\s+/i, '')
    .replace(/[.:;!?].*$/, '')
    .trim();

  if (!summary) {
    return `Figura del PDF: ${sectionTitle}`;
  }

  return summary.length > 72 ? `${summary.slice(0, 69).trim()}...` : summary;
};

const pickFallbackAnchorHeading = (
  image: PdfDocumentAssets['usedImages'][number],
  headings: string[],
  sectionTitle: string,
  sectionDescription: string
): string | undefined => {
  if (headings.length === 0) {
    return undefined;
  }

  const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const bestHeading = headings
    .map(heading => {
      const headingKeywords = new Set(getSearchKeywords(heading));
      const headingScore = scoreKeywordHits(imageHaystack, headingKeywords);
      const sectionScore = scoreKeywordHits(normalizeSearchText(heading), sectionKeywords);
      return {
        heading,
        score: headingScore * 2 + sectionScore,
      };
    })
    .sort((left, right) => right.score - left.score)[0];

  return bestHeading && bestHeading.score > 0 ? bestHeading.heading : undefined;
};

const buildFallbackImageRefs = (
  images: PdfDocumentAssets['usedImages'],
  sectionTitle: string,
  sectionDescription: string,
  contentMarkdown: string,
  visibleLabelByAssetId: Map<string, string>
): LessonImageRef[] => {
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const headings = getMarkdownHeadings(contentMarkdown);

  return images
    .map(image => {
      const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
      const headingScore = headings.reduce((total, heading) => {
        const headingKeywords = getSearchKeywords(heading);
        return Math.max(total, scoreKeywordHits(imageHaystack, headingKeywords));
      }, 0);
      const sectionScore = scoreKeywordHits(imageHaystack, sectionKeywords);

      return {
        image,
        score: sectionScore * 2 + headingScore,
      };
    })
    .filter(item => item.score >= MIN_FALLBACK_IMAGE_SCORE)
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    )
    .map(({ image }) => ({
      assetId: image.id,
      alt: sanitizePlaceholderValue(
        buildImageContextSummary(image, sectionTitle, sectionDescription) ||
          `Figura dal PDF: ${sectionTitle}`
      ),
      caption: sanitizePlaceholderValue(visibleLabelByAssetId.get(image.id) || ''),
      anchorHeading: pickFallbackAnchorHeading(image, headings, sectionTitle, sectionDescription),
    }));
};

const sanitizePlaceholderValue = (value: string): string =>
  value.replace(/[|}]/g, ' ').replace(/\s+/g, ' ').trim();

const buildPdfImagePlaceholder = (imageRef: LessonImageRef): string => {
  const alt = sanitizePlaceholderValue(imageRef.alt || 'Figura dal PDF');
  const caption = sanitizePlaceholderValue(imageRef.caption || '');
  return caption
    ? `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}|caption=${caption}}}`
    : `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}}}`;
};

const normalizeHeading = (text: string): string =>
  normalizeSearchText(text.replace(/^#+\s*/, '').replace(/[*_`]/g, ' '));

const injectImagePlaceholders = (contentMarkdown: string, imageRefs: LessonImageRef[]): string => {
  if (!contentMarkdown.trim() || imageRefs.length === 0) {
    return contentMarkdown.trim();
  }

  const lines = contentMarkdown.trim().split('\n');
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(item => /^(#{1,6})\s+/.test(item.line));
  const headingIndexByName = new Map(
    headingIndexes.map(item => [normalizeHeading(item.line), item.index])
  );

  let appendedCount = 0;

  imageRefs.forEach((imageRef, position) => {
    const placeholder = buildPdfImagePlaceholder(imageRef);
    const headingIndex = imageRef.anchorHeading
      ? headingIndexByName.get(normalizeHeading(imageRef.anchorHeading))
      : undefined;
    const fallbackIndex =
      headingIndexes[position + 1]?.index ??
      headingIndexes[position]?.index ??
      headingIndexes[0]?.index ??
      Math.max(lines.length - 1, 0);
    const insertAfterIndex = headingIndex ?? fallbackIndex;
    const insertionIndex = Math.min(insertAfterIndex + 1 + appendedCount * 3, lines.length);
    lines.splice(insertionIndex, 0, '', placeholder, '');
    appendedCount += 1;
  });

  return lines
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
};

const normalizeImagePlacements = (
  placements: SectionImagePlacement[] | undefined,
  availableAssetIds: Set<string>,
  visibleLabelByAssetId: Map<string, string>
): LessonImageRef[] => {
  if (!Array.isArray(placements)) {
    return [];
  }

  const refs: LessonImageRef[] = [];
  const seenAssetIds = new Set<string>();

  placements.forEach(placement => {
    if (
      !placement ||
      typeof placement.assetId !== 'string' ||
      !availableAssetIds.has(placement.assetId) ||
      seenAssetIds.has(placement.assetId)
    ) {
      return;
    }

    const alt = sanitizePlaceholderValue(placement.alt || 'Figura dal PDF');
    if (!alt) {
      return;
    }

    refs.push({
      assetId: placement.assetId,
      alt,
      caption:
        sanitizePlaceholderValue(
          placement.caption || visibleLabelByAssetId.get(placement.assetId) || ''
        ) || undefined,
      anchorHeading: placement.anchorHeading
        ? sanitizePlaceholderValue(placement.anchorHeading)
        : undefined,
    });
    seenAssetIds.add(placement.assetId);
  });

  return refs;
};

const sanitizeAssetIdMentions = (
  contentMarkdown: string,
  visibleLabelByAssetId: Map<string, string>
): string =>
  contentMarkdown
    .replace(
      /\b([Ff]igura|[Ii]mmagine)\s+(pdf-img-\d+)\b/g,
      (_match, noun: string, assetId: string) => {
        const label = visibleLabelByAssetId.get(assetId.toLowerCase());
        return label ? `${noun} "${label}"` : `${noun} seguente`;
      }
    )
    .replace(/\b(pdf-img-\d+)\b/gi, (_match, assetId: string) => {
      const label = visibleLabelByAssetId.get(assetId.toLowerCase());
      return label ? `"${label}"` : 'figura seguente';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/""/g, '"');

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;
const LABEL_BODY_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s+(.+)$/;
const STANDALONE_LABEL_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s*$/;
const MAX_LIST_LABEL_WORDS = 12;
const REPETITION_SIMILARITY_THRESHOLD = 0.72;
const REPETITION_SECONDARY_KEYWORD_THRESHOLD = 0.2;
const REPETITION_FULL_WORD_OVERLAP_THRESHOLD = 0.45;
const REPETITION_MIN_SHARED_KEYWORDS = 3;
const REPETITION_RECENT_PARAGRAPH_WINDOW = 4;
const REPETITION_MIN_KEYWORD_COUNT = 8;
const PARAGRAPH_REPETITION_STOP_WORDS = new Set([
  'alla',
  'alle',
  'anche',
  'avere',
  'come',
  'core',
  'cosa',
  'cui',
  'dalla',
  'dalle',
  'della',
  'delle',
  'dello',
  'dentro',
  'dopo',
  'essere',
  'framework',
  'function',
  'functions',
  'hanno',
  'hanno',
  'loro',
  'nelle',
  'nella',
  'nelle',
  'non',
  'organization',
  'organizzazione',
  'organizzazioni',
  'partire',
  'perche',
  'pero',
  'questa',
  'queste',
  'questi',
  'questo',
  'quindi',
  'risultati',
  'risultato',
  'sono',
  'solo',
  'stessa',
  'stesso',
  'subcategories',
  'subcategory',
  'tutte',
  'tutti',
]);

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const stripMarkdownForSimilarity = (value: string): string =>
  value
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/[*_#>|[\]()`~]/g, ' ')
    .replace(/\{\{PDF_IMAGE:[^}]+\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeSimilarityWord = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

const extractParagraphKeywords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 4 && !PARAGRAPH_REPETITION_STOP_WORDS.has(word))
    )
  );

const extractParagraphWords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 2)
    )
  );

interface ParagraphSimilarityMetrics {
  fullWordOverlap: number;
  keywordOverlap: number;
  sharedKeywordCount: number;
}

const computeParagraphSimilarity = (left: string, right: string): ParagraphSimilarityMetrics => {
  const leftKeywords = extractParagraphKeywords(left);
  const rightKeywords = extractParagraphKeywords(right);
  const leftWords = extractParagraphWords(left);
  const rightWords = extractParagraphWords(right);
  const rightWordSet = new Set(rightWords);
  const sharedWordCount = leftWords.filter(word => rightWordSet.has(word)).length;

  const rightKeywordSet = new Set(rightKeywords);
  const sharedKeywordCount = leftKeywords.filter(keyword => rightKeywordSet.has(keyword)).length;

  return {
    fullWordOverlap: sharedWordCount / Math.max(1, Math.min(leftWords.length, rightWords.length)),
    keywordOverlap:
      leftKeywords.length < REPETITION_MIN_KEYWORD_COUNT ||
      rightKeywords.length < REPETITION_MIN_KEYWORD_COUNT
        ? 0
        : sharedKeywordCount / Math.max(1, Math.min(leftKeywords.length, rightKeywords.length)),
    sharedKeywordCount,
  };
};

const isRedundantParagraphMatch = (metrics: ParagraphSimilarityMetrics): boolean =>
  metrics.keywordOverlap >= REPETITION_SIMILARITY_THRESHOLD ||
  (metrics.sharedKeywordCount >= REPETITION_MIN_SHARED_KEYWORDS &&
    metrics.keywordOverlap >= REPETITION_SECONDARY_KEYWORD_THRESHOLD &&
    metrics.fullWordOverlap >= REPETITION_FULL_WORD_OVERLAP_THRESHOLD);

const isMeaningfulParagraphForRepetitionCheck = (paragraph: string): boolean => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (!normalized || BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) {
    return false;
  }

  return extractParagraphKeywords(paragraph).length >= REPETITION_MIN_KEYWORD_COUNT;
};

interface RepetitionHit {
  currentIndex: number;
  previousIndex: number;
  similarity: number;
}

const findRedundantParagraphPairs = (paragraphs: string[]): RepetitionHit[] => {
  const hits: RepetitionHit[] = [];

  paragraphs.forEach((paragraph, index) => {
    if (!isMeaningfulParagraphForRepetitionCheck(paragraph)) {
      return;
    }

    const startIndex = Math.max(0, index - REPETITION_RECENT_PARAGRAPH_WINDOW);
    for (let previousIndex = startIndex; previousIndex < index; previousIndex += 1) {
      const previousParagraph = paragraphs[previousIndex];
      if (!isMeaningfulParagraphForRepetitionCheck(previousParagraph)) {
        continue;
      }

      const similarity = computeParagraphSimilarity(previousParagraph, paragraph);
      if (isRedundantParagraphMatch(similarity)) {
        hits.push({
          currentIndex: index,
          previousIndex,
          similarity: Math.max(similarity.keywordOverlap, similarity.fullWordOverlap),
        });
        break;
      }
    }
  });

  return hits;
};

export const collapseRedundantParagraphs = (contentMarkdown: string): string => {
  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return contentMarkdown.trim();
  }

  const keptParagraphs: string[] = [];

  paragraphs.forEach(paragraph => {
    if (!isMeaningfulParagraphForRepetitionCheck(paragraph)) {
      keptParagraphs.push(paragraph);
      return;
    }

    const recentParagraphs = keptParagraphs.slice(-REPETITION_RECENT_PARAGRAPH_WINDOW);
    const hasRedundantMatch = recentParagraphs.some(previousParagraph => {
      if (!isMeaningfulParagraphForRepetitionCheck(previousParagraph)) {
        return false;
      }

      return isRedundantParagraphMatch(computeParagraphSimilarity(previousParagraph, paragraph));
    });

    if (!hasRedundantMatch) {
      keptParagraphs.push(paragraph);
    }
  });

  return keptParagraphs.join('\n\n').trim();
};

const isReasonableListLabel = (label: string): boolean => {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 90 || !/^[A-ZÀ-ÖØ-Þ]/.test(trimmed)) {
    return false;
  }

  const words = trimmed.split(/\s+/);
  return words.length <= MAX_LIST_LABEL_WORDS;
};

const toStandaloneSubheading = (paragraph: string): string | null => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) {
    return null;
  }

  const match = normalized.match(STANDALONE_LABEL_REGEX);
  if (!match) {
    return null;
  }

  const label = match[1].trim();
  return isReasonableListLabel(label) ? `#### ${label}` : null;
};

const toListItemParagraph = (paragraph: string): string | null => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) {
    return null;
  }

  const match = normalized.match(LABEL_BODY_REGEX);
  if (!match) {
    return null;
  }

  const [, rawLabel, rawBody] = match;
  const label = rawLabel.trim();
  const body = rawBody.trim();

  if (!isReasonableListLabel(label) || !body) {
    return null;
  }

  return `- **${label}**: ${body}`;
};

const normalizePseudoLists = (contentMarkdown: string): string => {
  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  const normalizedParagraphs: string[] = [];

  for (let index = 0; index < paragraphs.length; ) {
    const standaloneSubheading = toStandaloneSubheading(paragraphs[index]);
    if (standaloneSubheading) {
      normalizedParagraphs.push(standaloneSubheading);
      index += 1;
      continue;
    }

    const listItems: string[] = [];
    let cursor = index;

    while (cursor < paragraphs.length) {
      const item = toListItemParagraph(paragraphs[cursor]);
      if (!item) {
        break;
      }

      listItems.push(item);
      cursor += 1;
    }

    if (listItems.length >= 2) {
      normalizedParagraphs.push(listItems.join('\n'));
      index = cursor;
      continue;
    }

    normalizedParagraphs.push(paragraphs[index]);
    index += 1;
  }

  return normalizedParagraphs.join('\n\n');
};

const stripModelMarkdownImages = (contentMarkdown: string): string =>
  contentMarkdown
    .replace(/!\[[^\]]*]\([^)\n]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');

const QUIZ_SECTION_HEADING_REGEX =
  /^\s{0,3}(#{1,6}\s*(?:quiz|verifica|domande(?:\s+di\s+verifica)?|test\s+finale|quiz\s+finale|domande\s+finali)\s*)$/gim;

const stripStructuredQuizFromMarkdown = (
  contentMarkdown: string,
  structuredQuiz: QuizQuestion[]
): string => {
  if (structuredQuiz.length === 0) {
    return contentMarkdown;
  }

  const headingMatch = Array.from(contentMarkdown.matchAll(QUIZ_SECTION_HEADING_REGEX))[0];
  if (headingMatch?.index !== undefined) {
    return contentMarkdown.slice(0, headingMatch.index).trim();
  }

  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return contentMarkdown.trim();
  }

  let firstQuizParagraphIndex = -1;

  for (let index = 0; index < paragraphs.length; index += 1) {
    const normalized = paragraphs[index].toLowerCase();
    const looksLikeQuizIntro =
      /^(quiz|verifica|domande(?:\s+di\s+verifica)?|test\s+finale)/i.test(paragraphs[index]) ||
      (normalized.includes('domanda 1') && normalized.includes('risposta')) ||
      (normalized.includes('1.') && normalized.includes('2.') && normalized.includes('3.'));

    if (looksLikeQuizIntro) {
      firstQuizParagraphIndex = index;
      break;
    }
  }

  if (firstQuizParagraphIndex === -1) {
    return contentMarkdown.trim();
  }

  return paragraphs.slice(0, firstQuizParagraphIndex).join('\n\n').trim();
};

const sanitizeLessonMarkdownContent = (
  contentMarkdown: string,
  structuredQuiz: QuizQuestion[],
  visibleLabelByAssetId?: Map<string, string>
): string => {
  let next = contentMarkdown || '';

  if (visibleLabelByAssetId) {
    next = sanitizeAssetIdMentions(next, visibleLabelByAssetId);
  }

  next = stripModelMarkdownImages(next);
  next = stripStructuredQuizFromMarkdown(next, structuredQuiz);
  next = collapseRedundantParagraphs(next);
  return normalizeMarkdownForRendering(prettifyMarkdownSpacing(next));
};

const countMeaningfulLessonWords = (contentMarkdown: string): number =>
  stripMarkdownForSimilarity(contentMarkdown)
    .split(/\s+/)
    .map(normalizeSimilarityWord)
    .filter(word => word.length >= 2).length;

const countMeaningfulLessonParagraphs = (contentMarkdown: string): number =>
  contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(
      paragraph =>
        paragraph.length > 0 &&
        !BLOCKISH_PARAGRAPH_PREFIX.test(normalizeParagraphForDetection(paragraph))
    ).length;

export const estimateTargetQuizCount = (contentMarkdown: string): number => {
  const trimmed = contentMarkdown.trim();
  if (!trimmed) {
    return MIN_LESSON_QUIZ_QUESTIONS;
  }

  const wordCount = countMeaningfulLessonWords(trimmed);
  const paragraphCount = countMeaningfulLessonParagraphs(trimmed);
  const headingCount = getMarkdownHeadings(trimmed).length;

  if (
    wordCount >= 1600 ||
    (wordCount >= 1200 && paragraphCount >= 8) ||
    (wordCount >= 1400 && headingCount >= 5)
  ) {
    return 3;
  }

  if (wordCount >= 450 || paragraphCount >= 4 || headingCount >= 3) {
    return 2;
  }

  return 1;
};

const WHOLE_QUIZ_CODE_FENCE_REGEX = /^\s*```(?:[a-z0-9_+-]+)?\s*\n([\s\S]*?)\n```\s*$/i;
const WHOLE_QUIZ_INLINE_CODE_REGEX = /^\s*(`+)([\s\S]*?)\1\s*$/;

const unwrapWholeQuizCodeFormatting = (value: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return '';
  }

  const fencedMatch = trimmedValue.match(WHOLE_QUIZ_CODE_FENCE_REGEX);
  if (fencedMatch) {
    return fencedMatch[1].trim().replace(/\s*\n+\s*/g, ' ');
  }

  const inlineMatch = trimmedValue.match(WHOLE_QUIZ_INLINE_CODE_REGEX);
  if (!inlineMatch) {
    return trimmedValue;
  }

  const unwrapped = inlineMatch[2].trim();
  return unwrapped ? unwrapped.replace(/\s*\n+\s*/g, ' ') : trimmedValue;
};

const sanitizeQuizQuestion = (question: QuizQuestion): QuizQuestion => ({
  exerciseType: normalizeActivePauseExerciseType(question.exerciseType),
  question: unwrapWholeQuizCodeFormatting(question.question),
  options: question.options.map(option => unwrapWholeQuizCodeFormatting(option)),
  correctIndex: question.correctIndex,
});

const isValidQuizQuestionPayload = (item: unknown): item is QuizQuestion => {
  if (typeof item !== 'object' || item === null) {
    return false;
  }

  const candidate = item as Partial<QuizQuestion>;
  return (
    typeof candidate.question === 'string' &&
    Array.isArray(candidate.options) &&
    candidate.options.length === LESSON_QUIZ_OPTION_COUNT &&
    candidate.options.every(option => typeof option === 'string') &&
    Number.isInteger(candidate.correctIndex) &&
    typeof candidate.correctIndex === 'number' &&
    candidate.correctIndex >= 0 &&
    candidate.correctIndex < candidate.options.length
  );
};

const normalizeQuizLength = (quiz: QuizQuestion[], targetQuizCount: number): QuizQuestion[] =>
  quiz.slice(0, clampLessonQuizCount(targetQuizCount)).map(sanitizeQuizQuestion);

const LESSON_CONCLUSION_HEADING_REGEX = /(^|\n)#{1,6}\s+Conclusione\b/i;
const LESSON_ABORTED_ENDING_REGEX =
  /(include|includono|comprende|comprendono|principali sono|si dividono in|origini includono)\s*:\s*$/i;
const BROKEN_DISPLAY_MATH_BRACKET_REGEX = /(^|\n)\[\s*\n[\s\S]*?\n\]\s*(?=\n|$)/m;
const BROKEN_KATEX_DELIMITER_REGEX = /(^|\n)(?:\[\s*$|\]\s*$)/m;

const getLessonMarkdownIssues = (contentMarkdown: string): string[] => {
  const issues: string[] = [];
  const trimmed = contentMarkdown.trim();
  if (!trimmed) {
    return ['Il contenuto e vuoto.'];
  }

  if (/[:;,]\s*$/.test(trimmed) || LESSON_ABORTED_ENDING_REGEX.test(trimmed)) {
    issues.push(
      'La lezione sembra tronca o si interrompe su un elenco introdotto ma non completato.'
    );
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  const labelLikeParagraphs = paragraphs.filter(paragraph => {
    const normalized = normalizeParagraphForDetection(paragraph);
    return (
      !BLOCKISH_PARAGRAPH_PREFIX.test(normalized) &&
      (LABEL_BODY_REGEX.test(normalized) || STANDALONE_LABEL_REGEX.test(normalized))
    );
  }).length;

  if (paragraphs.length >= 8 && labelLikeParagraphs / paragraphs.length > 0.35) {
    issues.push('La prosa e troppo frammentata in blocchi stile lista o pseudo-lista.');
  }

  const meaningfulLines = trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^(#{1,6}\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/.test(line));
  const markdownListLines = meaningfulLines.filter(line => /^([-*+]|\d+\.)\s+/.test(line)).length;

  if (meaningfulLines.length >= 14 && markdownListLines / meaningfulLines.length > 0.4) {
    issues.push('La lezione usa troppe liste rispetto ai paragrafi discorsivi.');
  }

  const redundantParagraphPairs = findRedundantParagraphPairs(paragraphs);
  if (redundantParagraphPairs.length > 0) {
    issues.push(
      'La lezione ribadisce piu volte lo stesso concetto in paragrafi troppo simili tra loro.'
    );
  }

  if (trimmed.length > 3500 && !LESSON_CONCLUSION_HEADING_REGEX.test(trimmed)) {
    issues.push('Manca una conclusione esplicita.');
  }

  if (
    BROKEN_DISPLAY_MATH_BRACKET_REGEX.test(trimmed) ||
    BROKEN_KATEX_DELIMITER_REGEX.test(trimmed)
  ) {
    issues.push(
      'La formattazione KaTeX/LaTeX sembra malformata: correggi delimitatori e sintassi matematica per il rendering.'
    );
  }

  return issues;
};

const repairLessonMarkdown = async (
  contentMarkdown: string,
  sectionTitle: string,
  sectionDescription: string,
  sourceContext: string,
  generationNotes?: string
): Promise<string> => {
  const issues = getLessonMarkdownIssues(contentMarkdown);
  if (issues.length === 0) {
    return contentMarkdown;
  }

  const userNotesBlock = buildUserGenerationNotesBlock(generationNotes);

  const repairPrompt = `Sei un editor didattico di Nous Reader.

Devi REVISIONARE una lezione markdown gia generata.
${userNotesBlock}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

PROBLEMI DA CORREGGERE:
${issues.map(issue => `- ${issue}`).join('\n')}

REGOLE:
1. Mantieni i contenuti validi e il significato tecnico originale.
2. Se il testo e troncato, completalo in modo coerente usando il contesto sorgente.
3. Riduci lo stile lista-like: preferisci paragrafi completi e usa liste solo per vere enumerazioni.
4. Elimina ripetizioni inutili, parafrasi ravvicinate e reiterazioni della stessa idea tra sezioni vicine.
5. Non ripetere il titolo della lezione nel corpo e non lasciare heading duplicati o consecutivi identici.
6. Taglia frasi metadiscorsive o riempitive come "questo e importante", "in pratica", "il punto centrale e" quando non aggiungono informazione tecnica nuova.
7. Mantieni il tono discorsivo, ma riduci analogie ed esempi superflui: usa analogie solo per concetti davvero difficili o astratti, non come abitudine stilistica.
8. Non lasciare sigle, abbreviazioni o acronimi non spiegati: alla prima occorrenza scioglili e chiariscili.
9. Evita forestierismi inutili: se esiste un equivalente italiano naturale e chiaro, preferiscilo.
10. Preferisci spiegazioni dirette ed esempi tratti dal materiale sorgente. Evita formule ricorrenti come "l'analogia piu utile e", "pensiamolo come", "e come se" salvo casi rari in cui chiariscono davvero un passaggio difficile.
11. Evita il tono da saggio divulgativo: niente piccoli riassunti, tesi di paragrafo o frasi che riformulano subito la stessa idea con parole diverse.
12. Mantieni heading chiari e chiudi con una sezione "Conclusione".
13. Se due paragrafi stanno difendendo la stessa tesi o ribadendo lo stesso contrasto concettuale, fondili in uno solo e tieni soltanto la formulazione piu chiara e utile.
14. NON inserire quiz nel testo.
15. NON inserire markdown image syntax, tag <img> o riferimenti ad asset tecnici.
16. Normalizza i blocchi di codice Markdown: usa solo fence standard del tipo \`\`\` oppure \`\`\`lang con il SOLO nome del linguaggio (es. \`\`\`cpp). Non aggiungere commenti, etichette o testo extra sulla stessa riga del fence.
17. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, fallo con una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
18. Correggi e normalizza anche la formattazione KaTeX/LaTeX: formule inline solo come \`$...$\` oppure \`\\(...\\)\`; formule display solo come \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare mai righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, e assicurati che parentesi, graffe e delimitatori siano bilanciati.
19. Restituisci SOLO markdown pulito, senza JSON e senza spiegazioni.

CONTESTO SORGENTE:
${sourceContext.slice(0, MAX_LESSON_REPAIR_SOURCE_CHARS)}

BOZZA ATTUALE DA REVISIONARE:
${contentMarkdown}`;

  return retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: HIGH_REASONING_CONFIG,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: repairPrompt },
        ],
        temperature: 0.15,
      }),
    1,
    500
  );
};

const prettifyMarkdownSpacing = (contentMarkdown: string): string =>
  normalizePseudoLists(
    contentMarkdown
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      // If a heading was accidentally kept inline, restore it as a block heading.
      .replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2')
      // Ensure a heading starts on its own block after normal text.
      .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );

const parseQuizPayload = (value: unknown): QuizQuestion[] =>
  Array.isArray(value) ? value.filter(isValidQuizQuestionPayload).map(sanitizeQuizQuestion) : [];

interface BuildLessonVerificationPromptInput {
  sectionTitle: string;
  sectionDescription: string;
  previousContext: string;
  sourceContext: string;
  continuityRule: string;
  scopeRule: string;
  targetQuizCount: number;
  draft: LessonVerificationDraft;
  candidateImages: Array<{
    assetId: string;
    pageNumber?: number;
    visibleLabel: string;
    caption?: string;
    sourceOrder: number;
  }>;
  generationNotes?: string;
}

export const buildLessonVerificationPrompt = ({
  sectionTitle,
  sectionDescription,
  previousContext,
  sourceContext,
  continuityRule,
  scopeRule,
  targetQuizCount,
  draft,
  candidateImages,
  generationNotes,
}: BuildLessonVerificationPromptInput): string => `Sei il verificatore finale di Nous Reader.

Ricevi una bozza quasi finale di lezione. Devi fare un controllo conclusivo e correggere SOLO cio che serve.
${buildUserGenerationNotesBlock(generationNotes)}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

OBIETTIVI DI VERIFICA:
1. La lezione deve restare strettamente nel focus della lezione corrente.
2. ${continuityRule}
3. Devono valere tutti questi vincoli di focus:
${scopeRule}
4. \`quiz\` deve contenere ESATTAMENTE ${clampLessonQuizCount(targetQuizCount)} pause attive con ESATTAMENTE 4 opzioni ciascuna.
5. Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
6. Non generare sempre domande: alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
7. Le pause del \`quiz\` NON devono mai chiedere di ripetere alla lettera una definizione appena data o copiare una frase della lezione.
8. Ogni pausa deve richiedere almeno una tra queste operazioni mentali: applicare un concetto a un caso, confrontare due casi, prevedere una conseguenza, riconoscere un errore, classificare un esempio, scegliere l'implicazione corretta.
9. I distrattori devono essere plausibili: niente opzioni caricaturali o palesemente assurde.
10. Le stringhe di \`quiz.question\` e \`quiz.options\` devono essere testo normale: non racchiudere MAI l'intera consegna o l'intera opzione in backticks, inline code o code fence. I backticks sono ammessi solo per un singolo termine, simbolo o identificatore interno alla frase quando servono davvero.
11. \`contentMarkdown\` non deve contenere quiz, markdown image syntax, tag <img>, assetId tecnici o riferimenti sbagliati alle immagini.
12. I heading devono essere coerenti e ogni \`anchorHeading\` in \`imagePlacements\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`.
13. Ogni immagine selezionata deve essere nel punto giusto della lezione: stessa sezione concettuale, stessa descrizione, stesso argomento.
14. Verifica con particolare severita che descrizione, caption e immagine siano abbinate correttamente: se una figura parla di ambient occlusion non puo essere usata per decals, overlay, particelle o altri argomenti diversi.
15. Ogni immagine selezionata deve anche essere visivamente chiara e autosufficiente: se appare sfocata, parziale, tagliata, poco leggibile, mostra solo un bordo, un wrapper, un riquadro, un badge, un'icona o un frammento non riconoscibile, rimuovila.
16. Se una figura e debole, ambigua, fuori tema o messa sotto il heading sbagliato, correggila o rimuovila. Meglio meno immagini che immagini sbagliate.
17. Se trovi forestierismi inutili nel testo, sostituiscili con equivalenti italiani naturali, salvo casi in cui il termine straniero sia davvero lo standard tecnico necessario.
18. Mantieni i contenuti validi e fai modifiche minime: non riscrivere tutto se non serve.
19. Se nessuna immagine candidata e chiaramente giusta, restituisci \`imagePlacements: []\`.
20. Verifica con severita anche la formattazione KaTeX/LaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non mischiare delimitatori diversi nella stessa formula, e correggi delimitatori o graffe non bilanciati.
21. Restituisci SOLO un oggetto JSON valido che rispetti esattamente lo schema richiesto.
22. Nei dati immagine, \`caption\` e una descrizione sintetica generata a partire dalla figura. Valuta la pertinenza usando solo la figura descritta da \`caption\`, il suo \`visibleLabel\` e il contesto della lezione, senza inventare dettagli non presenti.

ESTRATTI RILEVANTI DAL PDF / CONTESTO SORGENTE:
${sourceContext.slice(0, MAX_LESSON_REPAIR_SOURCE_CHARS)}

IMMAGINI CANDIDATE DISPONIBILI:
${candidateImages.length > 0 ? JSON.stringify(candidateImages, null, 2) : '[]'}

BOZZA ATTUALE DA VERIFICARE:
${JSON.stringify(draft, null, 2)}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione finale verificata in markdown",
  "quiz": [
    { "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ]
}`;

const verifyLessonDraft = async ({
  sectionTitle,
  sectionDescription,
  previousContext,
  sourceContext,
  continuityRule,
  scopeRule,
  targetQuizCount,
  draft,
  candidateImages,
  generationNotes,
}: BuildLessonVerificationPromptInput): Promise<LessonVerificationDraft> => {
  const verificationPrompt = buildLessonVerificationPrompt({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext,
    continuityRule,
    scopeRule,
    targetQuizCount,
    draft,
    candidateImages,
    generationNotes,
  });

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_FLASH,
        reasoning: HIGH_REASONING_CONFIG,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: verificationPrompt },
        ],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: buildLessonResponseSchema(targetQuizCount),
        },
      }),
    1,
    500
  );

  const parsed = parseCleanJson<PdfSectionContentPayload>(response || '{}');
  const verifiedQuiz = parseQuizPayload(parsed.quiz);
  return {
    contentMarkdown:
      typeof parsed.contentMarkdown === 'string' && parsed.contentMarkdown.trim()
        ? parsed.contentMarkdown
        : draft.contentMarkdown,
    quiz:
      verifiedQuiz.length > 0
        ? normalizeQuizLength(verifiedQuiz, targetQuizCount)
        : normalizeQuizLength(draft.quiz, targetQuizCount),
    imagePlacements: Array.isArray(parsed.imagePlacements)
      ? parsed.imagePlacements
          .filter(
            (placement): placement is LessonImageRef =>
              Boolean(placement) &&
              typeof placement.assetId === 'string' &&
              typeof placement.alt === 'string'
          )
          .map(placement => ({
            assetId: placement.assetId,
            alt: placement.alt,
            caption: placement.caption,
            anchorHeading: placement.anchorHeading,
          }))
      : draft.imagePlacements,
  };
};

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

const formatEstimatedPageRange = (
  span: { startPage: number; endPage: number } | null | undefined
): string | null => {
  if (!span) {
    return null;
  }

  return span.startPage === span.endPage
    ? `pag. ${span.startPage}`
    : `pag. ${span.startPage}-${span.endPage}`;
};

export const buildPdfChunkUsageDebugPayload = (
  sectionTitle: string,
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined,
  pageCount: number | undefined,
  targetedImagePages: number[] = [],
  pdfPages?: Array<{ pageNumber: number; text: string }>
): Record<string, unknown> | null => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return null;
  }

  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const hasStoredChunkPages = documentIndex.chunks.some(
    chunk => typeof chunk.pageStart === 'number' && typeof chunk.pageEnd === 'number'
  );
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const primaryChunks = (primaryChunkIds || [])
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
  const contextChunks = resolveLessonContextChunks(documentIndex, primaryChunkIds);
  const contextChunkSpans = contextChunks
    .map(chunk => ({
      chunk,
      span: resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout),
    }))
    .filter(item => Boolean(item.chunk));
  const pageStarts = contextChunkSpans
    .map(item => item.span?.startPage)
    .filter(Number.isFinite) as number[];
  const pageEnds = contextChunkSpans
    .map(item => item.span?.endPage)
    .filter(Number.isFinite) as number[];

  return {
    sectionTitle,
    pageCount: pageCount ?? 'unknown',
    primaryChunkIds: primaryChunks.map(chunk => chunk.id),
    primaryChunks: primaryChunks.map(chunk => ({
      id: chunk.id,
      sequence: chunk.sequence,
      headingPath: chunk.headingPath.join(' > ') || 'Nessuno',
      pageRange: formatEstimatedPageRange(
        resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout)
      ),
      pageRangeSource: resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout)?.exact
        ? 'exact'
        : 'estimated',
    })),
    promptContextChunkIds: contextChunks.map(chunk => chunk.id),
    promptContextPageRange:
      pageStarts.length > 0 && pageEnds.length > 0
        ? formatEstimatedPageRange({
            startPage: Math.min(...pageStarts),
            endPage: Math.max(...pageEnds),
          })
        : null,
    promptContextChunks: contextChunkSpans.map(({ chunk, span }) => ({
      id: chunk.id,
      sequence: chunk.sequence,
      headingPath: chunk.headingPath.join(' > ') || 'Nessuno',
      pageRange: formatEstimatedPageRange(span),
      pageRangeSource: span?.exact ? 'exact' : 'estimated',
    })),
    targetedImagePages:
      targetedImagePages.length > 0
        ? `pag. ${targetedImagePages[0]}-${targetedImagePages[targetedImagePages.length - 1]}`
        : null,
    pageMappingMode: pageLayout
      ? 'exact-from-page-text'
      : hasStoredChunkPages
        ? 'exact-from-chunk-metadata'
        : 'estimated-from-offsets',
  };
};

export const estimateRelevantPdfImagePages = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined,
  pageCount: number | undefined,
  pdfPages?: Array<{ pageNumber: number; text: string }>
): number[] => {
  if (!documentIndex || documentIndex.chunks.length === 0 || !pageCount || pageCount < 1) {
    return [];
  }

  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const anchorChunks =
    (primaryChunkIds || [])
      .map(chunkId => indexById.get(chunkId))
      .filter((chunk): chunk is PdfTextChunk => Boolean(chunk)) || [];
  const resolvedAnchorChunks =
    anchorChunks.length > 0
      ? anchorChunks
      : documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length));

  const pages = new Set<number>();

  resolvedAnchorChunks.forEach(chunk => {
    const span = resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout);
    if (!span) {
      return;
    }

    for (
      let page = Math.max(1, span.startPage - PDF_IMAGE_PAGE_RADIUS);
      page <= Math.min(pageCount, span.endPage + PDF_IMAGE_PAGE_RADIUS);
      page += 1
    ) {
      pages.add(page);
    }
  });

  return Array.from(pages).sort((left, right) => left - right);
};

const runInitialLearningPlan = async (
  file: FileData,
  assessmentSummary: string,
  sourceProfile: PlanningSourceProfile,
  onReasoningUpdate?: (reasoning: string) => void
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
- Ricorda che da questo indice verra derivata anche una fase laboratoriale: l ordine finale deve quindi sostenere esercizi pratici progressivi senza inversioni di prerequisiti.

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
    reasoning: HIGH_REASONING_CONFIG,
    onReasoningUpdate,
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
  sourceProfile: PlanningSourceProfile,
  onReasoningUpdate?: (reasoning: string) => void
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
- Ricorda che da questo indice verra derivata anche una fase laboratoriale: l ordine finale deve quindi sostenere esercizi pratici progressivi senza inversioni di prerequisiti.

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
    reasoning: HIGH_REASONING_CONFIG,
    onReasoningUpdate,
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
  onStatusUpdate?: (status: string) => void,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<LearningPlan> => {
  const assessmentSummary = buildAssessmentSummary(assessmentHistory);
  const sourceProfile = await resolvePlanningSourceProfile(file);

  return retryWithBackoff(async () => {
    onStatusUpdate?.('Bozza indice...');
    const initialPlan = await runInitialLearningPlan(
      file,
      assessmentSummary,
      sourceProfile,
      onReasoningUpdate
    );
    onStatusUpdate?.(`Raffinamento indice... ${initialPlan.sections.length} lezioni iniziali`);
    const refinedPlan = await runRefinedLearningPlan(
      file,
      assessmentSummary,
      initialPlan,
      sourceProfile,
      onReasoningUpdate
    );
    onStatusUpdate?.(`Indice raffinato: ${refinedPlan.sections.length} lezioni`);
    return refinedPlan;
  });
};

export const createSubChapterMetadata = async (
  file: FileData,
  parentSection: LearningSection,
  selection: string,
  userInstructions: string
): Promise<LearningSection> => {
  const prompt = `L'utente sta studiando il capitolo: "${parentSection.title}".
Descrizione capitolo: "${parentSection.description}".

L'utente ha evidenziato questo testo specifico: "${selection}".

Istruzioni dell'utente per l'approfondimento: "${userInstructions || 'Approfondisci questo concetto in dettaglio'}".

Il tuo compito e creare il METADATA per una nuova lezione (sotto-capitolo) dedicata esclusivamente a questo punto evidenziato.
Questa lezione deve essere un "Deep Dive".

Rispondi SOLO con un oggetto JSON:
{
  "title": "Titolo accattivante per la nuova lezione",
  "description": "Cosa si imparera in questo approfondimento"
}`;

  return retryWithBackoff(async () => {
    const userContent = await buildReasoningContentForFile(file, prompt, MAX_METADATA_SOURCE_CHARS);
    const response = await callOpenRouter({
      model: MODEL_REASONING,
      reasoning: HIGH_REASONING_CONFIG,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (!response) {
      throw new Error('Failed to generate sub-chapter metadata');
    }

    const json = parseCleanJson<{ title: string; description: string }>(response);
    return {
      id: crypto.randomUUID(),
      title: json.title,
      description: json.description,
      isCompleted: false,
      type: 'deep-dive',
      parentId: parentSection.id,
    };
  });
};

export const createLearnSubChapterMetadata = async (
  parentSection: LearningSection,
  selection: string,
  userInstructions: string,
  moduleTitle: string,
  profile: UserProfile | null
): Promise<LearningSection> => {
  const prompt = `Sei un curriculum architect esperto.

CONTESTO PERCORSO: "${profile?.topic || moduleTitle || parentSection.title}"
CONTESTO STUDENTE: "${profile?.context || 'Learner in a fileless AI-generated curriculum'}"
MODULO: "${moduleTitle || 'Percorso'}"
LEZIONE PADRE: "${parentSection.title}"
DESCRIZIONE LEZIONE PADRE: "${parentSection.description}"

TESTO EVIDENZIATO DALL'UTENTE:
"${selection}"

ISTRUZIONI EXTRA DELL'UTENTE:
"${userInstructions || 'Approfondisci questo concetto in dettaglio'}"

Il tuo compito e creare il METADATA per una nuova sottolezione deep dive.
Questa sottolezione deve essere coerente con il percorso corrente ma non dipendere da un file sorgente.

Rispondi SOLO con un oggetto JSON:
{
  "title": "Titolo specifico della nuova sottolezione",
  "description": "Cosa si imparera in questo approfondimento",
  "contextPrompt": "Prompt tecnico sintetico da usare poi per generare il contenuto della sottolezione"
}`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FLASH,
      reasoning: HIGH_REASONING_CONFIG,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    if (!response) {
      throw new Error('Failed to generate learn-mode sub-chapter metadata');
    }

    const json = parseCleanJson<{ title: string; description: string; contextPrompt?: string }>(
      response
    );
    return {
      id: crypto.randomUUID(),
      title: json.title,
      description: json.description,
      isCompleted: false,
      type: 'deep-dive',
      parentId: parentSection.id,
      contextPrompt:
        json.contextPrompt ||
        `${selection}\n\n${userInstructions || 'Approfondisci questo concetto in dettaglio'}`,
    };
  });
};

export const generateSectionContent = async (
  file: FileData,
  sectionTitle: string,
  sectionDescription: string,
  previousContext: string,
  primaryChunkIds?: string[],
  documentIndex?: PdfTextIndex | null,
  onStatusUpdate?: (status: string) => void,
  generationNotes?: string,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<{
  content: string;
  quiz: QuizQuestion[];
  imageRefs: LessonImageRef[];
  documentAssets: PdfDocumentAssets | null;
}> => {
  onStatusUpdate?.('Generazione lezione...');
  const isFirstLesson = previousContext.trim().length === 0;
  const continuityRule = isFirstLesson
    ? "PRIMA LEZIONE: non citare lezioni precedenti, capitoli gia visti, 'come abbiamo accennato', 'come vedremo', o altre formule di continuita retroattiva."
    : 'Se fai riferimenti al percorso, fallo solo usando il contesto precedente fornito e senza inventare lezioni mai avvenute.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  const userNotesBlock = buildUserGenerationNotesBlock(generationNotes);

  let pdfSession: Awaited<ReturnType<typeof getPdfAssetSession>> = null;
  let pdfTextSession: Awaited<ReturnType<typeof getPdfTextSession>> = null;
  let pdfPageCount: number | undefined;
  let relevantPdfPages: number[] = [];
  if (isPdfFile(file)) {
    onStatusUpdate?.('Analisi immagini...');
    try {
      pdfTextSession = await getPdfTextSession(file);
      pdfPageCount = pdfTextSession?.pageCount;
      relevantPdfPages = estimateRelevantPdfImagePages(
        documentIndex,
        primaryChunkIds,
        pdfPageCount,
        pdfTextSession?.pages
      );
      if (relevantPdfPages.length > 0) {
        onStatusUpdate?.(
          `Analisi immagini... pp. ${relevantPdfPages[0]}-${relevantPdfPages[relevantPdfPages.length - 1]}`
        );
      }

      pdfSession = await withSoftTimeout(
        getPdfAssetSession(file, {
          partialPages: relevantPdfPages,
        }),
        PDF_ASSET_SESSION_TIMEOUT_MS
      );
    } catch (error) {
      if (isSoftTimeoutError(error)) {
        console.warn(
          '[Nous][Lesson] PDF asset parsing timed out, continuing with text-only lesson generation for now.',
          error
        );
        onStatusUpdate?.('Salto immagini (PDF grande)...');
      } else {
        console.warn(
          'PDF asset parsing failed, falling back to text-only lesson generation.',
          error
        );
      }
    }
  }

  const pdfChunkUsageDebugPayload = isPdfFile(file)
    ? buildPdfChunkUsageDebugPayload(
        sectionTitle,
        documentIndex,
        primaryChunkIds,
        pdfPageCount,
        relevantPdfPages,
        pdfTextSession?.pages
      )
    : null;
  if (pdfChunkUsageDebugPayload) {
    logPdfLessonDebug('Chunk source usage', pdfChunkUsageDebugPayload);
  }

  if (pdfSession) {
    onStatusUpdate?.(`Analisi immagini... trovate ${pdfSession.images.length}`);
    const candidateImages = selectCandidatePdfImages(
      pdfSession.images,
      sectionTitle,
      sectionDescription,
      relevantPdfPages
    );
    logPdfLessonDebug('Candidate images selected', {
      sectionTitle,
      totalExtractedImages: pdfSession.images.length,
      candidateCount: candidateImages.length,
      candidates: candidateImages.map(image => ({
        id: image.id,
        pageNumber: image.pageNumber,
        caption: image.caption || '',
        sourceOrder: image.sourceOrder,
      })),
    });

    if (candidateImages.length === 0) {
      onStatusUpdate?.('Figure: nessuna pertinente');
    }

    const candidateImagePayload = candidateImages.map(image => ({
      assetId: image.id,
      pageNumber: image.pageNumber,
      visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
      caption: image.caption,
      sourceOrder: image.sourceOrder,
    }));
    const visibleLabelByAssetId = new Map(
      candidateImagePayload.map(image => [image.assetId.toLowerCase(), image.visibleLabel])
    );

    const lessonSourceContext = buildLessonChunkContext(documentIndex, primaryChunkIds);
    const prompt = `Sei il Professor Nous. Devi generare una LEZIONE COMPLETA E APPROFONDITA a partire da un PDF gia analizzato.
${userNotesBlock}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

ESTRATTI RILEVANTI DAL PDF PER QUESTA LEZIONE:
${lessonSourceContext || pdfSession.extractedText.slice(0, 12000)}

REGOLE FONDAMENTALI:
1. Scrivi una lezione esaustiva in Markdown ricco, ma ad alta densita informativa: niente riempitivo, niente ripetizioni decorative, niente giri larghi per dire poco.
2. Incorpora e spiega i contenuti del documento in modo discorsivo ma tecnico, con esempi concreti, formule (LaTeX $$...$$) e codice solo quando aiutano davvero la comprensione. Non fare riferimento a sezioni, pagine o strutture del testo sorgente ('il documento', 'la sezione X', 'il testo afferma'): la lezione deve funzionare come testo autonomo, senza presupporre che il lettore abbia il documento aperto. Quando introduci un concetto per la prima volta, parti da una definizione positiva ('X e Y'): le formulazioni per contrasto ('X non e soltanto Y') sono accettabili solo dopo che il concetto e gia stato definito. Tratta tabelle, blocchi comparativi, matrici, didascalie, legende e label testuali di grafici come parte del contenuto tecnico della lezione, non come rumore.
3. Organizza il testo con heading chiari, ma usa solo le sezioni che servono davvero a questa lezione. Non creare heading riempitivi.
4. Ogni sezione deve aggiungere informazione nuova. Non rispiegare la stessa definizione in Introduzione, Concetti Fondamentali e Analisi Approfondita con semplici parafrasi.
5. Non ripetere il titolo della lezione dentro \`contentMarkdown\` e non duplicare heading identici o quasi identici.
6. Evita metadiscorso e enfasi ridondante: non usare continuamente formule come "questo e importante", "in pratica", "il punto centrale e", "qui si capisce", salvo rarissimi casi.
7. Usa di default un lessico chiaro e accessibile: evita gergo e formulazioni troppo manualistiche quando una spiegazione diretta basta.
8. Quando un termine tecnico e necessario, collegalo subito al suo significato pratico o concettuale in parole comprensibili.
9. Non usare sigle, abbreviazioni o acronimi non spiegati: alla prima occorrenza devi sempre scioglierli e chiarirli.
10. Evita forestierismi inutili: se esiste un equivalente italiano naturale e chiaro, preferiscilo; tieni il termine straniero solo quando e davvero quello tecnico necessario.
11. Semplifica il modo di spiegare, non il contenuto: resta preciso senza sembrare accademico per posa.
12. Mantieni uno stile discorsivo e scorrevole, ma non divulgativo: evita di diluire il contenuto con troppe metafore o giri introduttivi.
13. Usa analogie solo se chiariscono davvero un concetto difficile. Al massimo 1 analogia breve nell'intera lezione, mai una per ogni paragrafo. Se puoi spiegare bene in modo diretto, non usare alcuna analogia.
14. Preferisci esempi concreti e riferimenti al materiale originale rispetto a metafore inventate. Se negli estratti compare una tabella o un confronto strutturato, rendilo con una tabella Markdown o una lista comparativa chiara invece di appiattirlo in testo confuso.
15. Evita formule stilistiche ricorrenti come "l'analogia piu utile e", "pensiamolo come", "e come se", salvo casi rari davvero necessari.
16. Evita mini-riassunti intermedi che ribadiscono subito cio che hai appena spiegato. Ogni paragrafo deve avanzare.
17. Se il nucleo concettuale della lezione e uno solo, spiegalo bene una volta e poi costruisci sopra implicazioni, esempi, limiti o conseguenze: non ribadirlo in tre sezioni diverse con parole leggermente cambiate.
18. Usa un numero di immagini proporzionato alla struttura della lezione. Se ci sono piu sezioni/heading, puoi usare piu immagini; evita solo ridondanze inutili.
19. Puoi referenziare SOLO questi assetId. Se nessuna immagine e chiaramente pertinente, restituisci un array vuoto.
20. Se usi un'immagine, \`anchorHeading\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`, senza i simboli #.
21. Se il materiale parla chiaramente di anatomia, strutture o meccanica visivamente spiegabili e tra le candidate c'e una figura pertinente, preferisci includerne almeno una.
22. Usa solo immagini visivamente chiare, autosufficienti e distinguibili. Escludi immagini sfocate, parziali, ritagliate, poco leggibili, decorative, badge, icone, bordi, wrapper di sezione, riquadri ornamentali o frammenti di figura.
23. Non usare il contesto testuale per indovinare una figura poco chiara: se l'immagine non si capisce da sola, non usarla.
24. ${continuityRule}
25. Vincoli di focus della lezione:
${scopeRule}
26. L'output finale DEVE rispettare rigorosamente lo schema JSON richiesto. Non scrivere testo fuori dal JSON.
27. \`quiz\` deve contenere da 1 a 3 pause attive con ESATTAMENTE 4 opzioni ciascuna.
28. Usa il numero MINIMO necessario di pause attive: 1 se la lezione ha un solo snodo concettuale forte, 2 se ha piu passaggi da consolidare, 3 solo se la lezione e davvero ampia e segmentata.
29. Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
30. Non generare sempre domande: alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
31. Le pause del \`quiz\` NON devono mai limitarsi a chiedere la ripetizione letterale di una definizione, di una formula o di una frase appena letta.
32. Ogni pausa deve richiedere applicazione, confronto, inferenza, diagnosi di errore, classificazione di un caso, sequenziamento, micro-sintesi oppure previsione di un effetto/conseguenza.
33. Le opzioni errate devono essere credibili e vicine agli errori concettuali tipici, non banalmente ridicole.
34. Le stringhe di \`quiz.question\` e \`quiz.options\` devono essere testo normale: non racchiudere MAI l'intera consegna o l'intera opzione in backticks, inline code o code fence. I backticks sono ammessi solo per un singolo termine, simbolo o identificatore interno alla frase quando servono davvero.
35. \`imagePlacements\` deve contenere solo assetId presenti nella lista fornita oppure essere un array vuoto.
36. Non racchiudere il JSON in markdown fences e non aggiungere spiegazioni prima o dopo il JSON.
37. NON citare MAI stringhe tecniche come \`pdf-img-004\` dentro \`contentMarkdown\`.
38. Se vuoi richiamare un'immagine nel testo, usa solo il suo \`visibleLabel\`, la sua caption oppure formule naturali come "nella figura seguente".
39. Quando elenchi 2 o piu elementi fratelli (tipi, gruppi, fasi, strutture, definizioni), usa una lista Markdown vera (\`-\` oppure \`1.\`).
40. Non scrivere pseudo-liste come paragrafi consecutivi del tipo "Etichetta: ..." senza bullet. Se non e una lista, allora fondi tutto in paragrafi completi.
41. Per i blocchi di codice, usa Markdown standard: la riga di apertura deve essere esattamente \`\`\`\` oppure \`\`\`\`lang con solo il nome del linguaggio (es. \`\`\`\`cpp). Non aggiungere commenti o testo extra sulla riga del fence.
42. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, usa una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
43. NON inserire markdown image syntax dentro \`contentMarkdown\` (niente \`![...](...)\` e niente tag \`<img>\`): le immagini vengono gestite SOLO tramite \`imagePlacements\`.
44. NON inserire una sezione quiz, domande o verifica dentro \`contentMarkdown\`: il quiz deve comparire SOLO nel campo strutturato \`quiz\`.
45. Se inserisci formule, assicurati che il Markdown sia compatibile con KaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare mai righe isolate con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non aprire una formula con un delimitatore e chiuderla con un altro, e chiudi sempre correttamente graffe e delimitatori.
46. Nei dati immagine, \`caption\` e una descrizione sintetica generata a partire dalla figura. Usa solo \`caption\`, \`visibleLabel\` e il contesto della lezione per decidere se l'immagine e pertinente: non inventare dettagli non esplicitati dalla descrizione.

IMMAGINI CANDIDATE:
${JSON.stringify(candidateImagePayload, null, 2)}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione completa in markdown",
  "quiz": [
    { "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ]
}`;

    const response = await retryWithBackoff(() =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: HIGH_REASONING_CONFIG,
        onReasoningUpdate,
        messages: [
          { role: 'system', content: teacherInstruction },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: LESSON_RESPONSE_SCHEMA,
        },
      })
    );

    const parsed = parseCleanJson<PdfSectionContentPayload>(response || '{}');
    traceLessonMarkdownStage('raw', sectionTitle, parsed.contentMarkdown || '');
    const structuredQuiz = parseQuizPayload(parsed.quiz);
    const repairedContentMarkdown = await repairLessonMarkdown(
      parsed.contentMarkdown || '',
      sectionTitle,
      sectionDescription,
      lessonSourceContext ||
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS),
      generationNotes
    ).catch(error => {
      console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
      return parsed.contentMarkdown || '';
    });
    traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');
    const targetQuizCount = estimateTargetQuizCount(repairedContentMarkdown);
    const draftQuiz = normalizeQuizLength(structuredQuiz, targetQuizCount);

    const availableAssetIds = new Set(candidateImages.map(image => image.id));
    const normalizedImageRefs = normalizeImagePlacements(
      parsed.imagePlacements,
      availableAssetIds,
      visibleLabelByAssetId
    );
    const fallbackImageRefs =
      normalizedImageRefs.length > 0
        ? []
        : buildFallbackImageRefs(
            candidateImages,
            sectionTitle,
            sectionDescription,
            repairedContentMarkdown,
            visibleLabelByAssetId
          );
    const draftImageRefs = normalizedImageRefs.length > 0 ? normalizedImageRefs : fallbackImageRefs;
    const draftImageSelectionMode =
      normalizedImageRefs.length > 0 ? 'model' : fallbackImageRefs.length > 0 ? 'fallback' : 'none';

    logPdfLessonDebug('Image placement result', {
      sectionTitle,
      contentHeadingCount: getMarkdownHeadings(repairedContentMarkdown).length,
      modelPlacementsRaw: parsed.imagePlacements || [],
      normalizedImageRefs,
      fallbackImageRefs,
      draftImageRefs,
      imageSelectionMode: draftImageSelectionMode,
    });

    onStatusUpdate?.('Verifica finale...');
    const verifiedDraft = await verifyLessonDraft({
      sectionTitle,
      sectionDescription,
      previousContext,
      sourceContext:
        lessonSourceContext ||
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS),
      continuityRule,
      scopeRule,
      targetQuizCount,
      draft: {
        contentMarkdown: repairedContentMarkdown,
        quiz: draftQuiz,
        imagePlacements: draftImageRefs,
      },
      candidateImages: candidateImagePayload,
      generationNotes,
    }).catch(error => {
      console.warn(
        '[Nous][Lesson] Final lesson verification failed, keeping pre-verified draft.',
        error
      );
      return {
        contentMarkdown: repairedContentMarkdown,
        quiz: draftQuiz,
        imagePlacements: draftImageRefs,
      } satisfies LessonVerificationDraft;
    });
    traceLessonMarkdownStage('verified', sectionTitle, verifiedDraft.contentMarkdown || '');

    const verifiedImageRefs = normalizeImagePlacements(
      verifiedDraft.imagePlacements,
      availableAssetIds,
      visibleLabelByAssetId
    );
    const imageRefs = verifiedImageRefs;
    const imageSelectionMode =
      imageRefs.length > 0
        ? verifiedImageRefs.length === draftImageRefs.length &&
          verifiedImageRefs.every((ref, index) => ref.assetId === draftImageRefs[index]?.assetId)
          ? draftImageSelectionMode
          : 'verified'
        : 'none';

    logPdfLessonDebug('Final lesson verification', {
      sectionTitle,
      verifiedImageRefs,
      imageSelectionMode,
      verifiedQuizCount: verifiedDraft.quiz.length,
    });

    if (imageSelectionMode === 'none') {
      onStatusUpdate?.(
        candidateImages.length > 0
          ? 'Immagini trovate ma nessuna ha superato i controlli di pertinenza'
          : 'Lezione generata senza immagini'
      );
    } else {
      onStatusUpdate?.(
        imageSelectionMode === 'model'
          ? `Lezione con ${imageRefs.length} immagini dal PDF`
          : imageSelectionMode === 'fallback'
            ? `Lezione con ${imageRefs.length} immagini dal PDF (fallback)`
            : `Lezione con ${imageRefs.length} immagini dal PDF (verificate)`
      );
    }

    const cleanedContentMarkdown = sanitizeLessonMarkdownContent(
      verifiedDraft.contentMarkdown,
      verifiedDraft.quiz,
      visibleLabelByAssetId
    );
    traceLessonMarkdownStage('cleaned', sectionTitle, cleanedContentMarkdown || '');
    const content = injectImagePlaceholders(cleanedContentMarkdown, imageRefs);

    return {
      content,
      quiz: normalizeQuizLength(verifiedDraft.quiz, targetQuizCount),
      imageRefs,
      documentAssets: buildStoredPdfDocumentAssets(pdfSession, imageRefs),
    };
  }

  const prompt = `Sei il Professor Nous. Devi generare una LEZIONE COMPLETA E APPROFONDITA.
${userNotesBlock}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

REGOLE FONDAMENTALI:
1. **PROFONDITA**: Questa lezione deve essere ESAUSTIVA, ma non ridondante. Non limitarti a una panoramica, ma non ripetere la stessa definizione o lo stesso concetto in piu sezioni con lievi parafrasi.
   Spiega ogni concetto in dettaglio, ma con alta densita informativa: meno riempitivo, meno giri larghi, piu sostanza per frase.
2. **STRUTTURA DISCORSIVA**: Preferisci paragrafi completi, non una sequenza di punti telegrafici.
   La lezione deve leggersi come una spiegazione tecnica continua, non come una slide.
   Quando pero presenti 2 o piu elementi fratelli (tipi, gruppi, fasi, definizioni), usa una lista Markdown vera.
3. **LEZIONE AUTOSUFFICIENTE**: La lezione deve funzionare come testo autonomo: il lettore non ha il documento originale aperto. Non fare riferimento a sezioni, pagine o strutture del testo sorgente ('il documento', 'la sezione X', 'la parte 3', 'il testo afferma'). Incorpora i contenuti rilevanti direttamente nella spiegazione. Quando introduci un concetto per la prima volta, parti da una definizione positiva ('X e Y'): le formulazioni per contrasto ('X non e soltanto Y') sono accettabili solo dopo che il concetto e stato gia definito. Se il materiale sorgente contiene tabelle, blocchi comparativi, matrici, didascalie o label di grafici, trattali come contenuto sostanziale della lezione.
4. **ESEMPI E ANALOGIE**: Usa esempi pratici quando aiutano davvero, preferibilmente tratti dal materiale sorgente. Usa analogie solo per concetti difficili o astratti, e comunque al massimo 1 analogia breve nell'intera lezione. Se puoi spiegare bene in modo diretto, non usare analogie. Se compare una tabella o un confronto strutturato, rendilo con una tabella Markdown o con una lista comparativa chiara invece di perdere le relazioni tra righe e colonne.
5. **LINGUAGGIO ACCESSIBILE**: Usa di default un lessico chiaro, accessibile e poco manualistico. Se puoi spiegare bene una cosa senza gergo superfluo, fallo.
6. **TERMINI TECNICI CONTESTUALIZZATI**: Quando un termine tecnico e necessario, aggancialo subito al suo significato pratico o concettuale in parole comprensibili.
7. **SIGLE SPIEGATE**: Non usare sigle, abbreviazioni o acronimi non spiegati. Alla prima occorrenza devi sempre scioglierli e chiarirli.
8. **NO FORESTIERISMI INUTILI**: Evita forestierismi inutili. Se esiste un equivalente italiano naturale e chiaro, preferiscilo; tieni il termine straniero solo quando e davvero quello tecnico necessario.
9. **SEMPLIFICA L'ESPOSIZIONE, NON IL CONTENUTO**: Resta preciso e completo senza assumere un tono artificiosamente accademico.
10. **STRUTTURA**: Usa heading chiari, ma solo se servono davvero. Non inserire automaticamente sezioni come "Analisi Approfondita" o "Applicazioni Pratiche" se il focus della lezione non lo richiede.
11. **PROGRESSIONE**: Ogni sezione deve introdurre informazione nuova o un nuovo livello di dettaglio; evita riprese ridondanti di concetti gia spiegati poche righe sopra.
12. **NO TITOLO DUPLICATO**: Non ripetere il titolo della lezione all'inizio di \`contentMarkdown\` e non duplicare heading identici.
13. **STILE**: Mantieni un tono discorsivo ma sobrio. Evita metadiscorso e frasi-segnaposto come "questo e importante", "in pratica", "il punto centrale e" quando non aggiungono contenuto tecnico nuovo.
14. **NO SAGGIO DIVULGATIVO**: Non aprire continuamente paragrafi con formule come "un modo utile per capirlo", "l'analogia migliore", "pensiamolo come", "in sostanza". Vai dritto alla spiegazione tecnica.
15. **LUNGHEZZA**: E meglio essere comprensibili che prolissi. Completo non significa verboso.
16. **PARAGRAFI CHE AVANZANO**: Ogni paragrafo deve introdurre un fatto, una distinzione, una conseguenza o un esempio nuovo. Niente mini-riassunti subito dopo aver spiegato una cosa.
17. **NO PARAFRASI A CATENA**: Se il punto centrale della lezione e uno solo, spiegalo bene una volta e poi passa a implicazioni, esempi, limiti o applicazioni. Non ribadirlo in sezioni diverse con formulazioni quasi equivalenti.
18. **CONTINUITA NARRATIVA**: ${continuityRule}
19. **FOCUS DELLA LEZIONE**:
${scopeRule}
20. **OUTPUT OBBLIGATORIO**: La risposta finale deve essere SOLO un oggetto JSON valido.
21. **SCHEMA PAUSE ATTIVE**: \`quiz\` deve contenere da 1 a 3 pause attive con ESATTAMENTE 4 opzioni ciascuna.
22. **QUIZ PROPORZIONATO**: Usa il numero minimo necessario di pause attive: 1 se la lezione e compatta, 2 se ha piu snodi concettuali da consolidare, 3 solo se la lezione e davvero ampia e segmentata.
23. **TIPOLOGIE VARIATE**: Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
24. **NON SOLO DOMANDE**: Non generare sempre domande. Alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
25. **PAUSE INTELLIGENTI**: Le pause del \`quiz\` non devono mai chiedere solo la ripetizione letterale di una definizione o di una frase appena letta.
26. **RAGIONAMENTO**: Ogni pausa deve richiedere applicazione, confronto, inferenza, diagnosi di errore, classificazione di un caso, sequenziamento, micro-sintesi oppure previsione di una conseguenza.
27. **DISTRATTORI PLAUSIBILI**: Le opzioni errate devono sembrare errori realistici, non risposte palesemente assurde.
28. **TESTO NORMALE**: Le stringhe di \`quiz.question\` e \`quiz.options\` devono essere testo normale. Non racchiudere MAI l'intera consegna o l'intera opzione in backticks, inline code o code fence; usa i backticks solo per un singolo termine o simbolo interno alla frase quando e davvero necessario.
29. **NESSUN TESTO EXTRA**: Non aggiungere testo, commenti, markdown fences o spiegazioni fuori dal JSON.
30. **IMMAGINI**: Per questa richiesta \`imagePlacements\` deve essere un array vuoto.
31. **NO PSEUDO-LISTE**: Non scrivere blocchi con piu righe del tipo "Etichetta: ..." senza bullet. O fai una lista Markdown vera, oppure scrivi paragrafi completi.
32. **CODE BLOCK PULITI**: Per i blocchi di codice usa solo fence Markdown standard del tipo \`\`\` oppure \`\`\`lang con il solo nome del linguaggio. Niente testo extra o commenti sulla riga del fence.
33. **NO LABEL SPURIE**: Non scrivere righe isolate come \`cpp\`, \`ts\`, \`cpp // commento\` o simili prima di un code block. Se vuoi introdurre il codice, fallo in una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco.
34. **NO IMMAGINI INLINE**: Non inserire markdown image syntax o tag HTML immagine dentro \`contentMarkdown\`.
35. **NO QUIZ NEL TESTO**: Non aggiungere quiz, domande o sezioni di verifica dentro \`contentMarkdown\`; il quiz deve vivere solo nel campo \`quiz\`.

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione completa in markdown",
  "quiz": [
    { "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": []
}`;

  const userContent = await buildReasoningContentForFile(
    file,
    prompt,
    MAX_PDF_FALLBACK_LESSON_SOURCE_CHARS
  );
  const response = await retryWithBackoff(() =>
    callOpenRouter({
      model: MODEL_REASONING,
      reasoning: HIGH_REASONING_CONFIG,
      onReasoningUpdate,
      messages: [
        { role: 'system', content: teacherInstruction },
        {
          role: 'user',
          content: userContent,
        },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: LESSON_RESPONSE_SCHEMA,
      },
    })
  );
  const parsed = parseCleanJson<PdfSectionContentPayload>(response || '{}');
  traceLessonMarkdownStage('raw', sectionTitle, parsed.contentMarkdown || '');
  const structuredQuiz = parseQuizPayload(parsed.quiz);
  const repairedContentMarkdown = await repairLessonMarkdown(
    parsed.contentMarkdown || '',
    sectionTitle,
    sectionDescription,
    sectionDescription,
    generationNotes
  ).catch(error => {
    console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
    return parsed.contentMarkdown || '';
  });
  traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');
  const targetQuizCount = estimateTargetQuizCount(repairedContentMarkdown);
  const draftQuiz = normalizeQuizLength(structuredQuiz, targetQuizCount);

  onStatusUpdate?.('Verifica finale...');
  const verifiedDraft = await verifyLessonDraft({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext: sectionDescription,
    continuityRule,
    scopeRule,
    targetQuizCount,
    draft: {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: draftQuiz,
      imagePlacements: [],
    },
    candidateImages: [],
    generationNotes,
  }).catch(error => {
    console.warn(
      '[Nous][Lesson] Final lesson verification failed, keeping pre-verified draft.',
      error
    );
    return {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: draftQuiz,
      imagePlacements: [],
    } satisfies LessonVerificationDraft;
  });
  traceLessonMarkdownStage('verified', sectionTitle, verifiedDraft.contentMarkdown || '');

  const cleanedContentMarkdown = sanitizeLessonMarkdownContent(
    verifiedDraft.contentMarkdown.trim(),
    verifiedDraft.quiz
  );
  traceLessonMarkdownStage('cleaned', sectionTitle, cleanedContentMarkdown);

  return {
    content: cleanedContentMarkdown,
    quiz: normalizeQuizLength(verifiedDraft.quiz, targetQuizCount),
    imageRefs: [],
    documentAssets: null,
  };
};

export { askContextualQuestion } from './contextChat.ts';
