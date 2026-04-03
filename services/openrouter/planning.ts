import {
  MODEL_CONTEXT,
  MODEL_FLASH,
  MODEL_REASONING,
  buildDocumentInputContent,
  buildAssessmentSummary,
  callOpenRouter,
  isPdfFile,
  parseCleanJson,
  plannerInstruction,
  retryWithBackoff,
  teacherInstruction,
  type FileData,
  type LessonImageRef,
  type LearningPlan,
  type LearningSection,
  type Message,
  type PdfDocumentAssets,
  type PdfTextChunk,
  type PdfTextIndex,
  type QuizQuestion,
  type UserProfile,
} from './shared.ts';
import { pushLuminaDebugTrace } from '../core/debugTrace.ts';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
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

const MIN_FALLBACK_IMAGE_SCORE = 2;
const PDF_PLACEHOLDER_PREFIX = '{{PDF_IMAGE:';
const MAX_PLAN_SOURCE_CHARS = 180_000;
const MAX_METADATA_SOURCE_CHARS = 32_000;
const MAX_CONTEXTUAL_ANSWER_SOURCE_CHARS = 32_000;
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
  pushLuminaDebugTrace(`lesson-markdown:${stage}`, {
    sectionTitle,
    ...summarizeLessonMarkdownForTrace(content),
  });
};

export const LESSON_SCOPE_RULES = [
  'Spiega solo il contenuto che appartiene davvero a questa lezione.',
  'Non anticipare in dettaglio argomenti che verranno trattati in lezioni future: puoi nominarli al massimo come collegamento o prerequisito, senza definirli, spiegarli o svilupparli.',
  'Non inserire sezioni di "analisi approfondita", "panoramica successiva" o simili se non aggiungono contenuto realmente necessario alla lezione corrente.',
  'Se la lezione ha gia esaurito il suo focus, chiudi con naturalezza: non allungarla per forza.',
] as const;

export const PLAN_PROPEDEUTIC_ORDER_RULES = [
  "L'indice finale deve essere in ordine strettamente propedeutico sia tra i moduli/capitoli sia tra le lezioni interne: prima prerequisiti e basi, poi concetti intermedi, poi argomenti avanzati, e solo alla fine la sintesi.",
  "Non mettere mai una sezione, una tecnica o un'applicazione prima della sezione che introduce definizioni, lessico e prerequisiti necessari per capirla.",
  'Ogni modulo deve preparare il successivo: prima fondamenta e modello mentale, poi meccanismi centrali, poi uso pratico, poi eccezioni, casi avanzati e ottimizzazioni.',
  'Anche dentro ogni modulo, le lezioni devono seguire una progressione didattica naturale dal semplice al complesso e dal generale allo specifico.',
  "Se durante il raffinamento spezzi una sezione in piu lezioni, riordinale sempre in base alle dipendenze didattiche prima di restituire l'indice finale.",
  "Se trovi elementi invertiti, correggi l'ordine: non lasciare mai un argomento dopo qualcosa che lo presuppone gia compreso.",
] as const;

export const LESSON_RESPONSE_SCHEMA = {
  name: 'lumina_lesson_response',
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
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: {
              type: 'string',
            },
            options: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: {
                type: 'string',
              },
            },
            correctIndex: {
              type: 'integer',
              minimum: 0,
              maximum: 3,
            },
          },
          required: ['question', 'options', 'correctIndex'],
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

const logPdfLessonDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Lumina][PDF Lesson] ${label}`);
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
  const keywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const scored = images
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

  // With long-context models, prefer recall over premature local filtering.
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

  const chosen = image.caption?.trim() || bestSentence || sentenceCandidates[0] || normalized || sectionTitle;
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

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

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
  return normalizeMarkdownForRendering(prettifyMarkdownSpacing(next));
};

const LESSON_CONCLUSION_HEADING_REGEX = /(^|\n)#{1,6}\s+Conclusione\b/i;
const LESSON_ABORTED_ENDING_REGEX =
  /(include|includono|comprende|comprendono|principali sono|si dividono in|origini includono)\s*:\s*$/i;

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

  if (trimmed.length > 3500 && !LESSON_CONCLUSION_HEADING_REGEX.test(trimmed)) {
    issues.push('Manca una conclusione esplicita.');
  }

  return issues;
};

const repairLessonMarkdown = async (
  contentMarkdown: string,
  sectionTitle: string,
  sectionDescription: string,
  sourceContext: string
): Promise<string> => {
  const issues = getLessonMarkdownIssues(contentMarkdown);
  if (issues.length === 0) {
    return contentMarkdown;
  }

  const repairPrompt = `Sei un editor didattico di Lumina Reader.

Devi REVISIONARE una lezione markdown gia generata.

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
13. NON inserire quiz nel testo.
14. NON inserire markdown image syntax, tag <img> o riferimenti ad asset tecnici.
15. Normalizza i blocchi di codice Markdown: usa solo fence standard del tipo \`\`\` oppure \`\`\`lang con il SOLO nome del linguaggio (es. \`\`\`cpp). Non aggiungere commenti, etichette o testo extra sulla stessa riga del fence.
16. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, fallo con una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
17. Restituisci SOLO markdown pulito, senza JSON e senza spiegazioni.

CONTESTO SORGENTE:
${sourceContext.slice(0, MAX_LESSON_REPAIR_SOURCE_CHARS)}

BOZZA ATTUALE DA REVISIONARE:
${contentMarkdown}`;

  return retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
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
  Array.isArray(value)
    ? value.filter(
        (item): item is QuizQuestion =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as QuizQuestion).question === 'string' &&
          Array.isArray((item as QuizQuestion).options) &&
          typeof (item as QuizQuestion).correctIndex === 'number'
      )
    : [];

interface BuildLessonVerificationPromptInput {
  sectionTitle: string;
  sectionDescription: string;
  previousContext: string;
  sourceContext: string;
  continuityRule: string;
  scopeRule: string;
  draft: LessonVerificationDraft;
  candidateImages: Array<{
    assetId: string;
    pageNumber?: number;
    visibleLabel: string;
    caption?: string;
    sourceContextBefore: string;
    sourceContextCurrent?: string;
    sourceContextAfter: string;
    sourceOrder: number;
  }>;
}

export const buildLessonVerificationPrompt = ({
  sectionTitle,
  sectionDescription,
  previousContext,
  sourceContext,
  continuityRule,
  scopeRule,
  draft,
  candidateImages,
}: BuildLessonVerificationPromptInput): string => `Sei il verificatore finale di Lumina Reader.

Ricevi una bozza quasi finale di lezione. Devi fare un controllo conclusivo e correggere SOLO cio che serve.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

OBIETTIVI DI VERIFICA:
1. La lezione deve restare strettamente nel focus della lezione corrente.
2. ${continuityRule}
3. Devono valere tutti questi vincoli di focus:
${scopeRule}
4. \`quiz\` deve contenere ESATTAMENTE 5 domande con ESATTAMENTE 4 opzioni ciascuna.
5. \`contentMarkdown\` non deve contenere quiz, markdown image syntax, tag <img>, assetId tecnici o riferimenti sbagliati alle immagini.
6. I heading devono essere coerenti e ogni \`anchorHeading\` in \`imagePlacements\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`.
7. Ogni immagine selezionata deve essere nel punto giusto della lezione: stessa sezione concettuale, stessa descrizione, stesso argomento.
8. Verifica con particolare severita che descrizione, caption e immagine siano abbinate correttamente: se una figura parla di ambient occlusion non puo essere usata per decals, overlay, particelle o altri argomenti diversi.
9. Se una figura e debole, ambigua, fuori tema o messa sotto il heading sbagliato, correggila o rimuovila. Meglio meno immagini che immagini sbagliate.
10. Se trovi forestierismi inutili nel testo, sostituiscili con equivalenti italiani naturali, salvo casi in cui il termine straniero sia davvero lo standard tecnico necessario.
11. Mantieni i contenuti validi e fai modifiche minime: non riscrivere tutto se non serve.
12. Se nessuna immagine candidata e chiaramente giusta, restituisci \`imagePlacements: []\`.
13. Restituisci SOLO un oggetto JSON valido che rispetti esattamente lo schema richiesto.
14. Nei dati immagine, \`caption\` e una descrizione sintetica generata; \`sourceContextCurrent\` e l'estratto reale della stessa pagina della figura; \`sourceContextBefore\` e \`sourceContextAfter\` sono gli estratti delle pagine adiacenti. Dai priorita a \`sourceContextCurrent\` per validare il tema effettivo della figura.

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
    { "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
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
  draft,
  candidateImages,
}: BuildLessonVerificationPromptInput): Promise<LessonVerificationDraft> => {
  const verificationPrompt = buildLessonVerificationPrompt({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext,
    continuityRule,
    scopeRule,
    draft,
    candidateImages,
  });

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_FLASH,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: verificationPrompt },
        ],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: LESSON_RESPONSE_SCHEMA,
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
    quiz: verifiedQuiz.length > 0 ? verifiedQuiz : draft.quiz,
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

const normalizeLearningPlan = (plan: LearningPlanDraft): LearningPlan => {
  const sections = Array.isArray(plan.sections) ? plan.sections : [];

  return {
    title: (plan.title || 'Percorso di studio').trim(),
    summary: (plan.summary || '').trim(),
    sections: sections
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
      .filter(section => section.title && section.description),
  };
};

const clipPdfSourceText = (text: string, maxChars: number): string => {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n\n[ESTRATTO PDF TRONCATO PER LIMITI DI CONTESTO]`;
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
  const pageStarts = contextChunkSpans.map(item => item.span?.startPage).filter(Number.isFinite) as number[];
  const pageEnds = contextChunkSpans.map(item => item.span?.endPage).filter(Number.isFinite) as number[];

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
    (primaryChunkIds || []).map(chunkId => indexById.get(chunkId)).filter(Boolean) || [];
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

const buildReasoningContentForFile = async (
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

TESTO ESTRATTO DAL PDF:
${clipPdfSourceText(extractedText, maxPdfChars)}`;
    }
  } catch (error) {
    console.warn('[Lumina][Planning] PDF text extraction failed for reasoning prompt.', error);
  }

  return `Documento: ${file.name}

${prompt}

Nota importante: non e stato possibile estrarre il testo del PDF in modo affidabile.
Non presumere dettagli non supportati e non affermare di aver letto il file se il contenuto non e presente nel prompt.`;
};

const runInitialLearningPlan = async (
  file: FileData,
  assessmentSummary: string
): Promise<LearningPlan> => {
  const prompt = `Analizza il documento allegato.
Ecco il contesto dell'utente (Assessment):
${assessmentSummary}

Crea un piano di studi dettagliato e NON troppo compresso.
- Se l'utente e principiante, aggiungi capitoli 'prerequisite' corposi.
- Raggruppa le sezioni in 3-6 moduli logici e assegna a ogni sezione un moduleTitle coerente.
- Punta a 10-18 lezioni totali, non 5-7 macro-capitoli.
- Ogni lezione deve coprire un solo concetto o sottosistema ben definito.
- Dividi il paper in sezioni logiche ('core').
- Aggiungi un capitolo finale di sintesi ('summary').
- Assicurati che i titoli siano descrittivi.
- La descrizione deve spiegare COSA si imparera in quella sezione.
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

  return normalizeLearningPlan(parseCleanJson<LearningPlanDraft>(response));
};

const runRefinedLearningPlan = async (
  file: FileData,
  assessmentSummary: string,
  draftPlan: LearningPlan
): Promise<LearningPlan> => {
  const prompt = `Sei un curriculum refiner. Hai gia un primo indice, ma e ancora troppo compresso.

CONTESTO UTENTE:
${assessmentSummary}

INDICE DA RAFFINARE:
${JSON.stringify(draftPlan, null, 2)}

Compito:
- Raffina questo indice in una versione PIU GRANULARE.
- Mantieni 3-6 moduli logici coerenti tramite moduleTitle.
- Porta il totale a circa 12-20 lezioni se il documento lo giustifica.
- Spezza ogni sezione troppo ampia in lezioni piu specifiche.
- Ogni lezione deve avere un focus netto e insegnabile.
- Evita titoli generici o riassuntivi quando il testo consente una divisione piu fine.
- Mantieni un solo capitolo finale di sintesi.
- Non creare lezioni duplicate.
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

  return normalizeLearningPlan(parseCleanJson<LearningPlanDraft>(response));
};

export const generateLearningPlan = async (
  file: FileData,
  assessmentHistory: Message[],
  onStatusUpdate?: (status: string) => void
): Promise<LearningPlan> => {
  const assessmentSummary = buildAssessmentSummary(assessmentHistory);

  return retryWithBackoff(async () => {
    onStatusUpdate?.('Bozza indice...');
    const initialPlan = await runInitialLearningPlan(file, assessmentSummary);
    onStatusUpdate?.(`Raffinamento indice... ${initialPlan.sections.length} lezioni iniziali`);
    const refinedPlan = await runRefinedLearningPlan(file, assessmentSummary, initialPlan);
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
  onStatusUpdate?: (status: string) => void
): Promise<{
  content: string;
  quiz: QuizQuestion[];
  imageRefs: LessonImageRef[];
  documentAssets: PdfDocumentAssets | null;
}> => {
  onStatusUpdate?.('Generazione lezione completa in corso...');
  const isFirstLesson = previousContext.trim().length === 0;
  const continuityRule = isFirstLesson
    ? "PRIMA LEZIONE: non citare lezioni precedenti, capitoli gia visti, 'come abbiamo accennato', 'come vedremo', o altre formule di continuita retroattiva."
    : 'Se fai riferimenti al percorso, fallo solo usando il contesto precedente fornito e senza inventare lezioni mai avvenute.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  let pdfSession: Awaited<ReturnType<typeof getPdfAssetSession>> = null;
  let pdfTextSession: Awaited<ReturnType<typeof getPdfTextSession>> = null;
  let pdfPageCount: number | undefined;
  let relevantPdfPages: number[] = [];
  if (isPdfFile(file)) {
    onStatusUpdate?.('Analisi immagini del PDF...');
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
          `Analisi immagini del PDF... pagine mirate ${relevantPdfPages[0]}-${relevantPdfPages[relevantPdfPages.length - 1]}`
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
          '[Lumina][Lesson] PDF asset parsing timed out, continuing with text-only lesson generation for now.',
          error
        );
        onStatusUpdate?.('PDF molto grande: continuo senza immagini per sbloccare la lezione...');
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
    onStatusUpdate?.(`Analisi immagini del PDF... trovate ${pdfSession.images.length}`);
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
        sourceContextBefore: image.textBefore,
        sourceContextCurrent: image.textCurrent || '',
        sourceContextAfter: image.textAfter,
      })),
    });

    if (candidateImages.length === 0) {
      onStatusUpdate?.('Nessuna immagine candidata trovata nel PDF');
    }

    const candidateImagePayload = candidateImages.map(image => ({
      assetId: image.id,
      pageNumber: image.pageNumber,
      visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
      caption: image.caption,
      sourceContextBefore: image.textBefore,
      sourceContextCurrent: image.textCurrent || '',
      sourceContextAfter: image.textAfter,
      sourceOrder: image.sourceOrder,
    }));
    const visibleLabelByAssetId = new Map(
      candidateImagePayload.map(image => [image.assetId.toLowerCase(), image.visibleLabel])
    );

    const lessonSourceContext = buildLessonChunkContext(documentIndex, primaryChunkIds);
    const prompt = `Sei il Professor Lumina. Devi generare una LEZIONE COMPLETA E APPROFONDITA a partire da un PDF gia analizzato.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

ESTRATTI RILEVANTI DAL PDF PER QUESTA LEZIONE:
${lessonSourceContext || pdfSession.extractedText.slice(0, 12000)}

REGOLE FONDAMENTALI:
1. Scrivi una lezione esaustiva in Markdown ricco, ma ad alta densita informativa: niente riempitivo, niente ripetizioni decorative, niente giri larghi per dire poco.
2. Cita e spiega il documento originale in modo discorsivo ma tecnico, con esempi concreti, formule (LaTeX $$...$$) e codice solo quando aiutano davvero la comprensione.
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
14. Preferisci esempi concreti e riferimenti al materiale originale rispetto a metafore inventate.
15. Evita formule stilistiche ricorrenti come "l'analogia piu utile e", "pensiamolo come", "e come se", salvo casi rari davvero necessari.
16. Evita mini-riassunti intermedi che ribadiscono subito cio che hai appena spiegato. Ogni paragrafo deve avanzare.
17. Usa un numero di immagini proporzionato alla struttura della lezione. Se ci sono piu sezioni/heading, puoi usare piu immagini; evita solo ridondanze inutili.
18. Puoi referenziare SOLO questi assetId. Se nessuna immagine e chiaramente pertinente, restituisci un array vuoto.
19. Se usi un'immagine, \`anchorHeading\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`, senza i simboli #.
20. Se il materiale parla chiaramente di anatomia, strutture o meccanica visivamente spiegabili e tra le candidate c'e una figura pertinente, preferisci includerne almeno una.
21. ${continuityRule}
22. Vincoli di focus della lezione:
${scopeRule}
23. L'output finale DEVE rispettare rigorosamente lo schema JSON richiesto. Non scrivere testo fuori dal JSON.
24. \`quiz\` deve contenere ESATTAMENTE 5 domande con ESATTAMENTE 4 opzioni ciascuna.
25. \`imagePlacements\` deve contenere solo assetId presenti nella lista fornita oppure essere un array vuoto.
26. Non racchiudere il JSON in markdown fences e non aggiungere spiegazioni prima o dopo il JSON.
27. NON citare MAI stringhe tecniche come \`pdf-img-004\` dentro \`contentMarkdown\`.
28. Se vuoi richiamare un'immagine nel testo, usa solo il suo \`visibleLabel\`, la sua caption oppure formule naturali come "nella figura seguente".
29. Quando elenchi 2 o piu elementi fratelli (tipi, gruppi, fasi, strutture, definizioni), usa una lista Markdown vera (\`-\` oppure \`1.\`).
30. Non scrivere pseudo-liste come paragrafi consecutivi del tipo "Etichetta: ..." senza bullet. Se non e una lista, allora fondi tutto in paragrafi completi.
31. Per i blocchi di codice, usa Markdown standard: la riga di apertura deve essere esattamente \`\`\` oppure \`\`\`lang con solo il nome del linguaggio (es. \`\`\`cpp). Non aggiungere commenti o testo extra sulla riga del fence.
32. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, usa una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
33. NON inserire markdown image syntax dentro \`contentMarkdown\` (niente \`![...](...)\` e niente tag \`<img>\`): le immagini vengono gestite SOLO tramite \`imagePlacements\`.
34. NON inserire una sezione quiz, domande o verifica dentro \`contentMarkdown\`: il quiz deve comparire SOLO nel campo strutturato \`quiz\`.
35. Nei dati immagine, \`caption\` e una descrizione sintetica generata; \`sourceContextCurrent\` e l'estratto reale della stessa pagina della figura; \`sourceContextBefore\` e \`sourceContextAfter\` sono le pagine adiacenti e vanno usati solo come supporto per verificare il tema corretto della figura.

IMMAGINI CANDIDATE:
${JSON.stringify(candidateImagePayload, null, 2)}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione completa in markdown",
  "quiz": [
    { "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ]
}`;

    const response = await retryWithBackoff(() =>
      callOpenRouter({
        model: MODEL_REASONING,
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
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS)
    ).catch(error => {
      console.warn('[Lumina][Lesson] Markdown repair failed, keeping original content.', error);
      return parsed.contentMarkdown || '';
    });
    traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');

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

    onStatusUpdate?.('Verifica finale lezione e immagini...');
    const verifiedDraft = await verifyLessonDraft({
      sectionTitle,
      sectionDescription,
      previousContext,
      sourceContext:
        lessonSourceContext ||
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS),
      continuityRule,
      scopeRule,
      draft: {
        contentMarkdown: repairedContentMarkdown,
        quiz: structuredQuiz,
        imagePlacements: draftImageRefs,
      },
      candidateImages: candidateImagePayload,
    }).catch(error => {
      console.warn('[Lumina][Lesson] Final lesson verification failed, keeping pre-verified draft.', error);
      return {
        contentMarkdown: repairedContentMarkdown,
        quiz: structuredQuiz,
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
      quiz: verifiedDraft.quiz,
      imageRefs,
      documentAssets: buildStoredPdfDocumentAssets(pdfSession, imageRefs),
    };
  }

  const prompt = `Sei il Professor Lumina. Devi generare una LEZIONE COMPLETA E APPROFONDITA.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

REGOLE FONDAMENTALI:
1. **PROFONDITA**: Questa lezione deve essere ESAUSTIVA, ma non ridondante. Non limitarti a una panoramica, ma non ripetere la stessa definizione o lo stesso concetto in piu sezioni con lievi parafrasi.
   Spiega ogni concetto in dettaglio, ma con alta densita informativa: meno riempitivo, meno giri larghi, piu sostanza per frase.
2. **STRUTTURA DISCORSIVA**: Preferisci paragrafi completi, non una sequenza di punti telegrafici.
   La lezione deve leggersi come una spiegazione tecnica continua, non come una slide.
   Quando pero presenti 2 o piu elementi fratelli (tipi, gruppi, fasi, definizioni), usa una lista Markdown vera.
3. **RIFERIMENTI AL TESTO**: Cita specificamente il documento originale.
4. **ESEMPI E ANALOGIE**: Usa esempi pratici quando aiutano davvero, preferibilmente tratti dal materiale sorgente. Usa analogie solo per concetti difficili o astratti, e comunque al massimo 1 analogia breve nell'intera lezione. Se puoi spiegare bene in modo diretto, non usare analogie.
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
17. **CONTINUITA NARRATIVA**: ${continuityRule}
18. **FOCUS DELLA LEZIONE**:
${scopeRule}
19. **OUTPUT OBBLIGATORIO**: La risposta finale deve essere SOLO un oggetto JSON valido.
20. **SCHEMA QUIZ**: \`quiz\` deve contenere ESATTAMENTE 5 domande a risposta multipla con ESATTAMENTE 4 opzioni ciascuna.
21. **NESSUN TESTO EXTRA**: Non aggiungere testo, commenti, markdown fences o spiegazioni fuori dal JSON.
22. **IMMAGINI**: Per questa richiesta \`imagePlacements\` deve essere un array vuoto.
23. **NO PSEUDO-LISTE**: Non scrivere blocchi con piu righe del tipo "Etichetta: ..." senza bullet. O fai una lista Markdown vera, oppure scrivi paragrafi completi.
24. **CODE BLOCK PULITI**: Per i blocchi di codice usa solo fence Markdown standard del tipo \`\`\` oppure \`\`\`lang con il solo nome del linguaggio. Niente testo extra o commenti sulla riga del fence.
25. **NO LABEL SPURIE**: Non scrivere righe isolate come \`cpp\`, \`ts\`, \`cpp // commento\` o simili prima di un code block. Se vuoi introdurre il codice, fallo in una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco.
26. **NO IMMAGINI INLINE**: Non inserire markdown image syntax o tag HTML immagine dentro \`contentMarkdown\`.
27. **NO QUIZ NEL TESTO**: Non aggiungere quiz, domande o sezioni di verifica dentro \`contentMarkdown\`; il quiz deve vivere solo nel campo \`quiz\`.

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione completa in markdown",
  "quiz": [
    { "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
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
    sectionDescription
  ).catch(error => {
    console.warn('[Lumina][Lesson] Markdown repair failed, keeping original content.', error);
    return parsed.contentMarkdown || '';
  });
  traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');

  onStatusUpdate?.('Verifica finale lezione...');
  const verifiedDraft = await verifyLessonDraft({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext: sectionDescription,
    continuityRule,
    scopeRule,
    draft: {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: structuredQuiz,
      imagePlacements: [],
    },
    candidateImages: [],
  }).catch(error => {
    console.warn('[Lumina][Lesson] Final lesson verification failed, keeping pre-verified draft.', error);
    return {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: structuredQuiz,
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
    quiz: verifiedDraft.quiz,
    imageRefs: [],
    documentAssets: null,
  };
};

interface AskContextualQuestionInput {
  file?: FileData | null;
  selection: string;
  question: string;
  lessonTitle?: string;
  lessonDescription?: string;
  lessonContent?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export const askContextualQuestion = async ({
  file,
  selection,
  question,
  lessonTitle,
  lessonDescription,
  lessonContent,
  contextBefore,
  contextAfter,
}: AskContextualQuestionInput): Promise<string> => {
  const selectionContext = [contextBefore, selection, contextAfter].filter(Boolean).join(' ');
  const basePrompt = `L'utente ha evidenziato questo testo:
"${selection}"

Contesto immediato della selezione:
"${selectionContext || selection}"

Domanda dell'utente:
"${question}"`;

  return retryWithBackoff(async () => {
    const userContent = file
      ? await buildReasoningContentForFile(
          file,
          `${basePrompt}

Rispondi in modo conciso e utile basandoti sul documento caricato.
Se la risposta e presente nella fonte originale, citala chiaramente.`,
          MAX_CONTEXTUAL_ANSWER_SOURCE_CHARS
        )
      : null;
    const response = await callOpenRouter({
      model: MODEL_CONTEXT,
      modelSlot: 'context',
      messages: file
        ? [
            {
              role: 'user',
              content: userContent,
            },
          ]
        : [
            {
              role: 'user',
              content: `${basePrompt}

Titolo lezione corrente: "${lessonTitle || 'Lezione corrente'}"
Descrizione lezione: "${lessonDescription || 'Nessuna descrizione disponibile'}"

Contenuto della lezione corrente:
${lessonContent || 'Nessun contenuto disponibile.'}

La fonte originale non e allegata. Rispondi usando solo il contesto della lezione corrente.
Se il dettaglio richiesto non e supportato dal testo disponibile, dichiaralo esplicitamente invece di inventare riferimenti.`,
            },
          ],
    });

    return response || 'Non ho potuto generare una risposta.';
  });
};
