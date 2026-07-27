import { sanitizeImagePlaceholderValue as sanitizePlaceholderValue } from '@shared/lessonPdfImageSelection';
import type {
  LessonGeneratedVisual,
  LessonImageRef,
  LessonVisualPlan,
  LessonVisualPlanningDecision,
  LessonVisualPlanningPass,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import { normalizeSearchText } from './planQuality.ts';
import {
  enforceVerifiedVisualTypeContract,
  generateVerifiedVisualSlots,
  type VerifiedVisualSlotPlan,
} from './visualExamples.ts';

const PDF_PLACEHOLDER_PREFIX = '{{PDF_IMAGE:';
const VISUAL_PLACEHOLDER_PREFIX = '{{VISUAL_EXAMPLE:';

export {
  buildFallbackImageRefs,
  buildVisibleImageLabel,
  getMarkdownHeadings,
  selectCandidatePdfImages,
} from '@shared/lessonPdfImageSelection';

export interface SectionImagePlacement {
  assetId: string;
  alt: string;
  caption?: string | null;
  anchorHeading?: string | null;
}

const buildPdfImagePlaceholder = (imageRef: LessonImageRef): string => {
  const alt = sanitizePlaceholderValue(imageRef.alt || 'Figura dal PDF');
  const caption = sanitizePlaceholderValue(imageRef.caption || '');
  return caption
    ? `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}|caption=${caption}}}`
    : `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}}}`;
};

const buildStoredVisualPlan = (plan: VerifiedVisualSlotPlan): LessonVisualPlan => ({
  anchorHeading: null,
  concept: plan.concept,
  pedagogicalGoal: plan.pedagogicalGoal,
  reason: plan.reason,
  visualType: plan.visualType,
});

const buildVisualPlanningPass = (
  plans: VerifiedVisualSlotPlan[],
  rationale: string
): LessonVisualPlanningPass => ({
  outcome: plans.length > 0 ? 'visuals' : 'none',
  plans: plans.map(buildStoredVisualPlan),
  rationale,
});

const removeVisualSlotMarkers = (contentMarkdown: string): string =>
  contentMarkdown
    .replaceAll(/\{\{VISUAL_SLOT:[^}]+}}/g, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

const getIntegratedVisualStatus = (completed: number, planned: number): string => {
  if (completed < planned) {
    return `${completed} di ${planned} esempi visivi integrati`;
  }
  return completed === 1 ? 'Esempio visivo integrato' : `${completed} esempi visivi integrati`;
};

export const materializeGeneratedVisualSlots = async ({
  contentMarkdown,
  generationNotes,
  hasPdfImages,
  onStatusUpdate,
  sectionDescription,
  sectionTitle,
  visualPlanning = {
    plans: [],
    rationale: 'Nessuna pianificazione visuale fornita.',
  },
}: {
  contentMarkdown: string;
  generationNotes?: string;
  hasPdfImages: boolean;
  onStatusUpdate?: (status: string) => void;
  sectionDescription: string;
  sectionTitle: string;
  visualPlanning?: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
}): Promise<{
  content: string;
  generatedVisualSlots: Array<{ slotId: string; visual: LessonGeneratedVisual }>;
  generatedVisuals: LessonGeneratedVisual[];
  visualPlanningDecision: LessonVisualPlanningDecision;
}> => {
  const failedDecision = (rationale: string): LessonVisualPlanningDecision => ({
    initial: { outcome: 'failed', plans: [], rationale },
    reviewed: { outcome: 'failed', plans: [], rationale },
    reviewedAt: timestampIso(),
  });
  const validPlans = visualPlanning.plans
    .filter(plan => {
      const marker = `{{VISUAL_SLOT:${plan.slotId}}}`;
      return (
        plan.slotId.trim().length > 0 &&
        contentMarkdown.indexOf(marker) >= 0 &&
        contentMarkdown.indexOf(marker) === contentMarkdown.lastIndexOf(marker)
      );
    })
    .map(enforceVerifiedVisualTypeContract);
  const reviewedPass = buildVisualPlanningPass(validPlans, visualPlanning.rationale);
  const decision: LessonVisualPlanningDecision = {
    initial: reviewedPass,
    reviewed: reviewedPass,
    reviewedAt: timestampIso(),
  };
  if (!contentMarkdown.trim()) {
    return {
      content: contentMarkdown,
      generatedVisualSlots: [],
      generatedVisuals: [],
      visualPlanningDecision: failedDecision(
        'La pianificazione visuale non può valutare una lezione vuota.'
      ),
    };
  }

  if (validPlans.length === 0) {
    return {
      content: removeVisualSlotMarkers(contentMarkdown),
      generatedVisualSlots: [],
      generatedVisuals: [],
      visualPlanningDecision: decision,
    };
  }

  try {
    onStatusUpdate?.('Generazione esempio visivo...');
    const results = await generateVerifiedVisualSlots(
      {
        generationNotes,
        hasPdfImages,
        lessonMarkdown: contentMarkdown,
        sectionDescription,
        sectionTitle,
      },
      validPlans
    );

    if (results.length === 0) {
      onStatusUpdate?.('Esempio visivo non disponibile');
      return {
        content: removeVisualSlotMarkers(contentMarkdown),
        generatedVisualSlots: [],
        generatedVisuals: [],
        visualPlanningDecision: decision,
      };
    }

    const visualBySlotId = new Map(results.map(result => [result.slotId, result.visual]));
    let content = contentMarkdown;
    for (const plan of validPlans) {
      const marker = `{{VISUAL_SLOT:${plan.slotId}}}`;
      const visual = visualBySlotId.get(plan.slotId);
      const replacement = visual
        ? `{{VISUAL_EXAMPLE:${visual.id}|title=${sanitizePlaceholderValue(visual.title)}}}`
        : '';
      content = content.replace(marker, replacement);
    }
    content = removeVisualSlotMarkers(content);
    onStatusUpdate?.(getIntegratedVisualStatus(results.length, validPlans.length));
    return {
      content,
      generatedVisualSlots: results,
      generatedVisuals: results.map(result => result.visual),
      visualPlanningDecision: decision,
    };
  } catch (error) {
    console.warn(
      '[Nous][Lesson] Generated visual example failed, keeping text-only lesson.',
      error
    );
    onStatusUpdate?.('Esempio visivo non disponibile');
    return {
      content: removeVisualSlotMarkers(contentMarkdown),
      generatedVisualSlots: [],
      generatedVisuals: [],
      visualPlanningDecision: failedDecision(
        'La pianificazione o la generazione visuale non è stata completata.'
      ),
    };
  }
};

export const retryGeneratedVisualSlot = async ({
  contentMarkdown,
  generationNotes,
  hasPdfImages,
  plan,
  sectionDescription,
  sectionTitle,
}: {
  contentMarkdown: string;
  generationNotes?: string;
  hasPdfImages: boolean;
  plan: VerifiedVisualSlotPlan;
  sectionDescription: string;
  sectionTitle: string;
}): Promise<LessonGeneratedVisual | null> => {
  const [result] = await generateVerifiedVisualSlots(
    {
      generationNotes,
      hasPdfImages,
      lessonMarkdown: contentMarkdown,
      sectionDescription,
      sectionTitle,
    },
    [enforceVerifiedVisualTypeContract(plan)]
  );
  return result ? { ...result.visual, id: `visual-${plan.slotId}` } : null;
};

const normalizeHeading = (text: string): string =>
  normalizeSearchText(text.replace(/^#+\s*/, '').replaceAll(/[*_`]/g, ' '));

const HEADING_LINE_REGEX = /^(#{1,6})\s+/;
const FENCE_LINE_REGEX = /^(```|~~~)/;
const LIST_ITEM_LINE_REGEX = /^([-*+]|\d+\.)\s+/;
const TABLE_LINE_REGEX = /^\|.*\|$/;

const findSectionEndIndex = (lines: string[], headingIndex: number): number => {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (HEADING_LINE_REGEX.test(lines[index] || '')) {
      return index;
    }
  }

  return lines.length;
};

const findFirstReadableBlockEndIndex = (lines: string[], headingIndex: number): number => {
  const sectionEndIndex = findSectionEndIndex(lines, headingIndex);

  let blockStartIndex = -1;
  for (let index = headingIndex + 1; index < sectionEndIndex; index += 1) {
    const line = (lines[index] || '').trim();
    if (
      !line ||
      line.startsWith(PDF_PLACEHOLDER_PREFIX) ||
      line.startsWith(VISUAL_PLACEHOLDER_PREFIX)
    ) {
      continue;
    }

    blockStartIndex = index;
    break;
  }

  if (blockStartIndex < 0) {
    return headingIndex;
  }

  const firstLine = (lines[blockStartIndex] || '').trim();
  if (FENCE_LINE_REGEX.test(firstLine)) {
    for (let index = blockStartIndex + 1; index < sectionEndIndex; index += 1) {
      if (FENCE_LINE_REGEX.test((lines[index] || '').trim())) {
        return index;
      }
    }
  }

  const isBlockContinuation = TABLE_LINE_REGEX.test(firstLine)
    ? (line: string): boolean => TABLE_LINE_REGEX.test(line.trim())
    : LIST_ITEM_LINE_REGEX.test(firstLine)
      ? (line: string): boolean => {
          const trimmed = line.trim();
          return LIST_ITEM_LINE_REGEX.test(trimmed) || (trimmed.length > 0 && /^\s+/.test(line));
        }
      : (line: string): boolean => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !HEADING_LINE_REGEX.test(trimmed);
        };

  let blockEndIndex = blockStartIndex;
  for (let index = blockStartIndex + 1; index < sectionEndIndex; index += 1) {
    if (!isBlockContinuation(lines[index] || '')) {
      break;
    }

    blockEndIndex = index;
  }

  return blockEndIndex;
};

export const injectImagePlaceholders = (
  contentMarkdown: string,
  imageRefs: LessonImageRef[]
): string => {
  if (!contentMarkdown.trim() || imageRefs.length === 0) {
    return contentMarkdown.trim();
  }

  const lines = contentMarkdown.trim().split('\n');
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(item => HEADING_LINE_REGEX.test(item.line));
  const headingIndexByName = new Map(
    headingIndexes.map(item => [normalizeHeading(item.line), item.index])
  );

  let appendedCount = 0;

  const placementTargets = imageRefs
    .map((imageRef, position) => {
      const headingIndex = imageRef.anchorHeading
        ? headingIndexByName.get(normalizeHeading(imageRef.anchorHeading))
        : undefined;
      const fallbackIndex =
        headingIndexes[position + 1]?.index ??
        headingIndexes[position]?.index ??
        headingIndexes[0]?.index ??
        Math.max(lines.length - 1, 0);
      const insertAfterIndex =
        headingIndex === undefined
          ? fallbackIndex
          : findFirstReadableBlockEndIndex(lines, headingIndex);

      return { imageRef, insertAfterIndex, position };
    })
    .sort(
      (first, second) =>
        first.insertAfterIndex - second.insertAfterIndex || first.position - second.position
    );

  placementTargets.forEach(({ imageRef, insertAfterIndex }) => {
    const placeholder = buildPdfImagePlaceholder(imageRef);
    const baseInsertionIndex = Math.min(insertAfterIndex + 1 + appendedCount * 3, lines.length);
    const insertionIndex =
      (lines[baseInsertionIndex] || '').trim() === ''
        ? Math.min(baseInsertionIndex + 1, lines.length)
        : baseInsertionIndex;
    lines.splice(insertionIndex, 0, '', placeholder, '');
    appendedCount += 1;
  });

  return lines
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
};

export const normalizeImagePlacements = (
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

export const sanitizeAssetIdMentions = (
  contentMarkdown: string,
  visibleLabelByAssetId: Map<string, string>
): string =>
  contentMarkdown
    .replaceAll(
      /\b([Ff]igura|[Ii]mmagine)\s+(pdf-img-\d+)\b/g,
      (_match, noun: string, assetId: string) => {
        const label = visibleLabelByAssetId.get(assetId.toLowerCase());
        return label ? `${noun} "${label}"` : `${noun} seguente`;
      }
    )
    .replaceAll(/\b(pdf-img-\d+)\b/gi, (_match, assetId: string) => {
      const label = visibleLabelByAssetId.get(assetId.toLowerCase());
      return label ? `"${label}"` : 'figura seguente';
    })
    .replaceAll(/[ \t]{2,}/g, ' ')
    .replaceAll(/""/g, '"');
