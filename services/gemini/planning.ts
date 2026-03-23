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
  type PdfTextIndex,
  type QuizQuestion,
  type UserProfile,
} from './shared.ts';
import { buildLessonChunkContext } from './documentIndex.ts';
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

const selectCandidatePdfImages = (
  images: PdfDocumentAssets['usedImages'],
  sectionTitle: string,
  sectionDescription: string
) => {
  const keywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const scored = images
    .map(image => {
      const haystack = normalizeSearchText(`${image.textBefore} ${image.textAfter}`);
      const score = scoreKeywordHits(haystack, keywords);
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

const getDynamicLessonImageLimit = (contentMarkdown: string): number => {
  const headingCount = getMarkdownHeadings(contentMarkdown).length;

  if (headingCount >= 6) {
    return 6;
  }

  if (headingCount >= 4) {
    return 4;
  }

  if (headingCount >= 2) {
    return 3;
  }

  return 2;
};

const buildImageContextSummary = (
  image: PdfDocumentAssets['usedImages'][number],
  sectionTitle: string,
  sectionDescription: string
): string => {
  const joinedContext = `${image.textBefore} ${image.textAfter}`.trim();
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

  const chosen = bestSentence || sentenceCandidates[0] || normalized || sectionTitle;
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

  const imageHaystack = normalizeSearchText(`${image.textBefore} ${image.textAfter}`);
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
  maxImages: number,
  visibleLabelByAssetId: Map<string, string>
): LessonImageRef[] => {
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const headings = getMarkdownHeadings(contentMarkdown);

  return images
    .map(image => {
      const imageHaystack = normalizeSearchText(`${image.textBefore} ${image.textAfter}`);
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
    .slice(0, maxImages)
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
  maxImages: number,
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
      seenAssetIds.has(placement.assetId) ||
      refs.length >= maxImages
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
  return prettifyMarkdownSpacing(next);
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
4. Mantieni heading chiari e chiudi con una sezione "Conclusione".
5. NON inserire quiz nel testo.
6. NON inserire markdown image syntax, tag <img> o riferimenti ad asset tecnici.
7. Restituisci SOLO markdown pulito, senza JSON e senza spiegazioni.

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

  let pdfSession = null;
  if (isPdfFile(file)) {
    onStatusUpdate?.('Analisi immagini del PDF...');
    try {
      pdfSession = await getPdfAssetSession(file);
    } catch (error) {
      console.warn('PDF asset parsing failed, falling back to text-only lesson generation.', error);
    }
  }

  if (pdfSession) {
    onStatusUpdate?.(`Analisi immagini del PDF... trovate ${pdfSession.images.length}`);
    const candidateImages = selectCandidatePdfImages(
      pdfSession.images,
      sectionTitle,
      sectionDescription
    );
    logPdfLessonDebug('Candidate images selected', {
      sectionTitle,
      totalExtractedImages: pdfSession.images.length,
      candidateCount: candidateImages.length,
      candidates: candidateImages.map(image => ({
        id: image.id,
        sourceOrder: image.sourceOrder,
        textBefore: image.textBefore.slice(-120),
        textAfter: image.textAfter.slice(0, 120),
      })),
    });

    if (candidateImages.length === 0) {
      onStatusUpdate?.('Nessuna immagine candidata trovata nel PDF');
    }

    const candidateImagePayload = candidateImages.map(image => ({
      assetId: image.id,
      visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
      textBefore: image.textBefore,
      textAfter: image.textAfter,
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
1. Scrivi una lezione esaustiva in Markdown ricco.
2. Cita e spiega il documento originale con esempi concreti, formule (LaTeX $$...$$) e codice quando appropriato.
3. Organizza il testo con heading chiari. Le sezioni consigliate sono:
   - Introduzione
   - Concetti Fondamentali
   - Analisi Approfondita
   - Applicazioni Pratiche
   - Conclusione
4. Usa un numero di immagini proporzionato alla struttura della lezione. Se ci sono piu sezioni/heading, puoi usare piu immagini; evita solo ridondanze inutili.
5. Puoi referenziare SOLO questi assetId. Se nessuna immagine e chiaramente pertinente, restituisci un array vuoto.
6. Se usi un'immagine, \`anchorHeading\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`, senza i simboli #.
7. Se il materiale parla chiaramente di anatomia, strutture o meccanica visivamente spiegabili e tra le candidate c'e una figura pertinente, preferisci includerne almeno una.
8. ${continuityRule}
9. L'output finale DEVE rispettare rigorosamente lo schema JSON richiesto. Non scrivere testo fuori dal JSON.
10. \`quiz\` deve contenere ESATTAMENTE 5 domande con ESATTAMENTE 4 opzioni ciascuna.
11. \`imagePlacements\` deve contenere solo assetId presenti nella lista fornita oppure essere un array vuoto.
12. Non racchiudere il JSON in markdown fences e non aggiungere spiegazioni prima o dopo il JSON.
13. NON citare MAI stringhe tecniche come \`pdf-img-004\` dentro \`contentMarkdown\`.
14. Se vuoi richiamare un'immagine nel testo, usa solo il suo \`visibleLabel\`, la sua caption oppure formule naturali come "nella figura seguente".
15. Quando elenchi 2 o piu elementi fratelli (tipi, gruppi, fasi, strutture, definizioni), usa una lista Markdown vera (\`-\` oppure \`1.\`).
16. Non scrivere pseudo-liste come paragrafi consecutivi del tipo "Etichetta: ..." senza bullet. Se non e una lista, allora fondi tutto in paragrafi completi.
17. NON inserire markdown image syntax dentro \`contentMarkdown\` (niente \`![...](...)\` e niente tag \`<img>\`): le immagini vengono gestite SOLO tramite \`imagePlacements\`.
18. NON inserire una sezione quiz, domande o verifica dentro \`contentMarkdown\`: il quiz deve comparire SOLO nel campo strutturato \`quiz\`.

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

    const maxLessonImages = getDynamicLessonImageLimit(repairedContentMarkdown);
    const availableAssetIds = new Set(candidateImages.map(image => image.id));
    const normalizedImageRefs = normalizeImagePlacements(
      parsed.imagePlacements,
      availableAssetIds,
      maxLessonImages,
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
            maxLessonImages,
            visibleLabelByAssetId
          );
    const imageRefs = normalizedImageRefs.length > 0 ? normalizedImageRefs : fallbackImageRefs;
    const imageSelectionMode =
      normalizedImageRefs.length > 0 ? 'model' : fallbackImageRefs.length > 0 ? 'fallback' : 'none';

    logPdfLessonDebug('Image placement result', {
      sectionTitle,
      contentHeadingCount: getMarkdownHeadings(repairedContentMarkdown).length,
      modelPlacementsRaw: parsed.imagePlacements || [],
      normalizedImageRefs,
      fallbackImageRefs,
      finalImageRefs: imageRefs,
      imageSelectionMode,
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
          : `Lezione con ${imageRefs.length} immagini dal PDF (fallback)`
      );
    }

    const cleanedContentMarkdown = sanitizeLessonMarkdownContent(
      repairedContentMarkdown,
      structuredQuiz,
      visibleLabelByAssetId
    );
    const content = injectImagePlaceholders(cleanedContentMarkdown, imageRefs);

    return {
      content,
      quiz: structuredQuiz,
      imageRefs,
      documentAssets: buildStoredPdfDocumentAssets(pdfSession, imageRefs),
    };
  }

  const prompt = `Sei il Professor Lumina. Devi generare una LEZIONE COMPLETA E APPROFONDITA.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

REGOLE FONDAMENTALI:
1. **PROFONDITA**: Questa lezione deve essere ESAUSTIVA. Non limitarti a una panoramica. 
   Spiega ogni concetto in dettaglio, con esempi concreti, formule (in LaTeX $$...$$), e codice dove appropriato.
2. **STRUTTURA DISCORSIVA**: Preferisci paragrafi completi, non una sequenza di punti telegrafici.
   La lezione deve leggersi come un capitolo di un libro, non come una slide.
   Quando pero presenti 2 o piu elementi fratelli (tipi, gruppi, fasi, definizioni), usa una lista Markdown vera.
3. **RIFERIMENTI AL TESTO**: Cita specificamente il documento originale.
4. **ESEMPI E ANALOGIE**: Ogni concetto importante deve avere un esempio pratico o un'analogia.
5. **STRUTTURA**:
   - Introduzione
   - Concetti Fondamentali
   - Analisi Approfondita
   - Applicazioni Pratiche
   - Conclusione
6. **LUNGHEZZA**: E meglio essere comprensibili che concisi.
7. **CONTINUITA NARRATIVA**: ${continuityRule}
8. **OUTPUT OBBLIGATORIO**: La risposta finale deve essere SOLO un oggetto JSON valido.
9. **SCHEMA QUIZ**: \`quiz\` deve contenere ESATTAMENTE 5 domande a risposta multipla con ESATTAMENTE 4 opzioni ciascuna.
10. **NESSUN TESTO EXTRA**: Non aggiungere testo, commenti, markdown fences o spiegazioni fuori dal JSON.
11. **IMMAGINI**: Per questa richiesta \`imagePlacements\` deve essere un array vuoto.
12. **NO PSEUDO-LISTE**: Non scrivere blocchi con piu righe del tipo "Etichetta: ..." senza bullet. O fai una lista Markdown vera, oppure scrivi paragrafi completi.
13. **NO IMMAGINI INLINE**: Non inserire markdown image syntax o tag HTML immagine dentro \`contentMarkdown\`.
14. **NO QUIZ NEL TESTO**: Non aggiungere quiz, domande o sezioni di verifica dentro \`contentMarkdown\`; il quiz deve vivere solo nel campo \`quiz\`.

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

  return {
    content: sanitizeLessonMarkdownContent(repairedContentMarkdown.trim(), structuredQuiz),
    quiz: structuredQuiz,
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
