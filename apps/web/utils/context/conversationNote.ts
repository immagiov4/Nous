import type {
  ConversationSelectionAnchor,
  SaveConversationNoteInput,
  SaveConversationNoteToolInput,
} from '../../components/workspace/shell/types.ts';

const normalizeOptionalText = (value: string | undefined) => {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : undefined;
};

const normalizeRequiredText = (value: string) => value.trim();

const areAnchorsEqual = (left: ConversationSelectionAnchor, right: ConversationSelectionAnchor) =>
  normalizeRequiredText(left.selectedText) === normalizeRequiredText(right.selectedText) &&
  normalizeOptionalText(left.contextBefore) === normalizeOptionalText(right.contextBefore) &&
  normalizeOptionalText(left.contextAfter) === normalizeOptionalText(right.contextAfter);

export const buildConversationNoteSaveCandidates = ({
  anchor,
  toolInput,
}: {
  anchor: ConversationSelectionAnchor;
  toolInput: SaveConversationNoteToolInput;
}): SaveConversationNoteInput[] => {
  const normalizedAnchor = {
    contextAfter: normalizeOptionalText(anchor.contextAfter),
    contextBefore: normalizeOptionalText(anchor.contextBefore),
    selectedText: normalizeRequiredText(anchor.selectedText),
  } satisfies ConversationSelectionAnchor;

  const primarySelection = {
    contextAfter: normalizeOptionalText(toolInput.contextAfter) || normalizedAnchor.contextAfter,
    contextBefore: normalizeOptionalText(toolInput.contextBefore) || normalizedAnchor.contextBefore,
    selectedText: normalizeRequiredText(toolInput.selectedText) || normalizedAnchor.selectedText,
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
