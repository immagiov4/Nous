import type {
  ConversationSelectionAnchor,
  SaveConversationNoteInput,
  SaveConversationNoteToolInput,
} from '../../components/workspace/shell/types.ts';
import { createSectionAnnotationSelector } from '../learning/sectionAnnotationAnchors.ts';
import {
  normalizeSectionAnnotationSelectionText,
  resolveSelectedSegments,
} from '../learning/sectionAnnotationProjection.ts';

const normalizeOptionalText = (value: string | undefined) => {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : undefined;
};

const normalizeRequiredText = (value: string) => value.trim();
const normalizeSelectedTextStart = (value: number | undefined) =>
  value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;

const haveMatchingTextContext = (
  left: ConversationSelectionAnchor,
  right: ConversationSelectionAnchor
) =>
  normalizeRequiredText(left.selectedText) === normalizeRequiredText(right.selectedText) &&
  normalizeOptionalText(left.contextBefore) === normalizeOptionalText(right.contextBefore) &&
  normalizeOptionalText(left.contextAfter) === normalizeOptionalText(right.contextAfter);

const areAnchorsEqual = (left: ConversationSelectionAnchor, right: ConversationSelectionAnchor) =>
  haveMatchingTextContext(left, right) &&
  normalizeSelectedTextStart(left.selectedTextStart) ===
    normalizeSelectedTextStart(right.selectedTextStart);

export const hasAnchorableConversationNoteCandidate = (
  content: string,
  candidate: ConversationSelectionAnchor &
    Partial<Pick<SaveConversationNoteInput, 'fallbackSelection'>>
): boolean => {
  const segments = resolveSelectedSegments({
    content,
    ...candidate,
    preferredSelection: candidate.fallbackSelection,
  });
  const selector = createSectionAnnotationSelector(content, segments);
  return (
    selector !== null &&
    normalizeSectionAnnotationSelectionText(selector.exact) ===
      normalizeSectionAnnotationSelectionText(candidate.selectedText)
  );
};

export const buildConversationNoteSaveCandidates = ({
  anchor,
  toolInput,
}: {
  anchor: ConversationSelectionAnchor;
  toolInput: SaveConversationNoteToolInput;
}): SaveConversationNoteInput[] => {
  const normalizedAnchorStart = normalizeSelectedTextStart(anchor.selectedTextStart);
  const normalizedAnchor = {
    contextAfter: normalizeOptionalText(anchor.contextAfter),
    contextBefore: normalizeOptionalText(anchor.contextBefore),
    selectedText: normalizeRequiredText(anchor.selectedText),
    ...(normalizedAnchorStart !== undefined ? { selectedTextStart: normalizedAnchorStart } : {}),
  } satisfies ConversationSelectionAnchor;

  const primarySelectedText =
    normalizeRequiredText(toolInput.selectedText) || normalizedAnchor.selectedText;
  const canReuseAnchorContext = primarySelectedText === normalizedAnchor.selectedText;
  const primaryContextAfter =
    normalizeOptionalText(toolInput.contextAfter) ||
    (canReuseAnchorContext ? normalizedAnchor.contextAfter : undefined);
  const primaryContextBefore =
    normalizeOptionalText(toolInput.contextBefore) ||
    (canReuseAnchorContext ? normalizedAnchor.contextBefore : undefined);
  const primaryTextSelection = {
    ...(primaryContextAfter ? { contextAfter: primaryContextAfter } : {}),
    ...(primaryContextBefore ? { contextBefore: primaryContextBefore } : {}),
    selectedText: primarySelectedText,
  } satisfies ConversationSelectionAnchor;
  const primarySelectionStart =
    normalizeSelectedTextStart(toolInput.selectedTextStart) ?? normalizedAnchor.selectedTextStart;
  const primarySelection = {
    ...primaryTextSelection,
    ...(primarySelectionStart !== undefined ? { selectedTextStart: primarySelectionStart } : {}),
  } satisfies ConversationSelectionAnchor;

  const primaryCandidate = {
    ...primarySelection,
    ...(toolInput.artifactRefs ? { artifactRefs: toolInput.artifactRefs } : {}),
    ...(toolInput.generatedVisuals ? { generatedVisuals: toolInput.generatedVisuals } : {}),
    note: normalizeRequiredText(toolInput.note),
    fallbackSelection: normalizedAnchor,
  } satisfies SaveConversationNoteInput;

  if (areAnchorsEqual(primarySelection, normalizedAnchor)) {
    return [primaryCandidate];
  }

  return [
    primaryCandidate,
    {
      ...normalizedAnchor,
      ...(primaryCandidate.artifactRefs ? { artifactRefs: primaryCandidate.artifactRefs } : {}),
      ...(primaryCandidate.generatedVisuals
        ? { generatedVisuals: primaryCandidate.generatedVisuals }
        : {}),
      note: primaryCandidate.note,
      fallbackSelection: normalizedAnchor,
    } satisfies SaveConversationNoteInput,
  ];
};
