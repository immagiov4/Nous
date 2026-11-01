import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type ContextNoteResult, createContextNoteValidationError } from '@shared/contextNote';
import { type ContextNoteRecord, readContextNoteSnapshotId } from '@shared/contextNoteCatalog';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from '@shared/lessonSourceContext';
import type { ConversationSelectionAnchor } from '../../components/workspace/shell/types.ts';
import type { SectionAnnotationTextSelector } from '../../types.ts';
import { createSectionAnnotationSelector } from '../learning/sectionAnnotationAnchors.ts';
import { resolveSelectedSegments } from '../learning/sectionAnnotationProjection.ts';
import { equalAnnotationSelectors } from '../learning/sectionAnnotations.ts';
import {
  getMarkdownAnnotationProtectedRanges,
  type MarkdownRange,
  mergeOverlappingMarkdownRanges,
  parseMarkdownAnalysis,
} from '../markdown/codeRanges.ts';
import {
  buildMarkableSegments,
  buildSourceSegments,
  buildVisibleProjection,
  normalizeWhitespace,
  type VisibleProjection,
} from '../markdown/textProjection.ts';

interface ConversationNotePassage {
  id: string;
  kind: 'paragraph' | 'heading' | 'tableCell' | 'selection';
  text: string;
  anchor: ConversationSelectionAnchor;
  selector: SectionAnnotationTextSelector;
  segments: MarkdownRange[];
  content: string;
  annotationId?: string;
  origin?: { projectId?: string; lessonId?: string };
  hasExistingNote: boolean;
}

/** Historical pending quotes can be converted only when their exact target is unambiguous. */
export const resolveConversationNotePassage = (
  catalog: ReturnType<typeof buildConversationNoteCatalog>,
  input: { passageId?: string; selectedTextDraft?: string }
): ConversationNotePassage | undefined => {
  if (input.passageId !== undefined)
    return catalog.entries.find(entry => entry.id === input.passageId);
  const quote = input.selectedTextDraft?.trim();
  if (!quote) return undefined;
  const projection = buildVisibleProjection(catalog.content);
  const start = projection.text.indexOf(quote);
  if (start < 0 || projection.text.indexOf(quote, start + 1) >= 0) return undefined;
  const target = buildConversationNoteCatalog({
    content: catalog.content,
    locale: catalog.locale,
    origin: catalog.origin,
    selection: { selectedText: quote, selectedTextStart: start },
  }).entries.find(entry => entry.kind === 'selection');
  if (!target) return undefined;
  return (
    catalog.entries.find(
      entry =>
        entry.kind === 'selection' && equalAnnotationSelectors(entry.selector, target.selector)
    ) ?? target
  );
};
export const validateConversationNotePassage = ({
  catalog,
  input,
  current,
}: {
  catalog: ReturnType<typeof buildConversationNoteCatalog>;
  input: { passageId?: string; selectedTextDraft?: string };
  current: { lessonContent?: string; projectId?: string; lessonId?: string };
}): {
  target?: ConversationNotePassage;
  error?: Extract<ContextNoteResult, { status: 'validation_error' }>;
} => {
  const target = resolveConversationNotePassage(catalog, input);
  if (
    catalog.content !== (current.lessonContent ?? '') ||
    catalog.origin?.projectId !== current.projectId ||
    catalog.origin?.lessonId !== current.lessonId
  )
    return {
      target,
      error: createContextNoteValidationError('stale_context', []),
    };
  if (
    catalog.annotationTargetMismatch &&
    (input.passageId === 's' || (target?.kind === 'selection' && catalog.entries.includes(target)))
  )
    return {
      error: createContextNoteValidationError(
        'anchor_mismatch',
        catalog.entries.filter(entry => entry.kind !== 'selection').map(entry => entry.id)
      ),
    };
  if (target) return { target };
  if (!catalog.entries.length)
    return {
      error: createContextNoteValidationError('no_annotatable_passage', []),
    };
  return {
    error: createContextNoteValidationError(
      'unknown_passage',
      catalog.entries.map(entry => entry.id)
    ),
  };
};

const buildProtectedProjectionIndexes = (
  projection: VisibleProjection,
  ranges: MarkdownRange[]
) => {
  const indexes = new Set<number>();
  let cursor = 0;
  for (let index = 0; index < projection.text.length; index++) {
    while (cursor < ranges.length && ranges[cursor].end <= projection.sourceIndexes[index])
      cursor++;
    const range = ranges[cursor];
    if (
      range &&
      projection.sourceEnds[index] > range.start &&
      projection.sourceIndexes[index] < range.end
    )
      indexes.add(index);
  }
  return indexes;
};

const markableProjectionRuns = (
  range: MarkdownRange,
  protectedIndexes: ReadonlySet<number>
): MarkdownRange[] => {
  const runs: MarkdownRange[] = [];
  let start = range.start;
  for (let index = range.start; index < range.end; index++) {
    if (!protectedIndexes.has(index)) continue;
    runs.push({ start, end: index });
    start = index + 1;
  }
  runs.push({ start, end: range.end });
  return runs;
};

const capturedSelectionRange = (
  content: string,
  projection: VisibleProjection,
  selection?: ConversationSelectionAnchor
): MarkdownRange | undefined => {
  if (!selection?.selectedText.trim()) return undefined;
  const segments = resolveSelectedSegments({ content, ...selection });
  const selector = createSectionAnnotationSelector(content, segments, projection);
  if (selector?.exact !== normalizeWhitespace(selection.selectedText)) return undefined;
  const start = projection.sourceIndexes.findIndex(index => index >= selector.start);
  const end = projection.sourceIndexes.findIndex(index => index >= selector.end);
  const positionMatches =
    selection.selectedTextStart === undefined || selection.selectedTextStart === start;
  const repeatedWithoutPosition =
    selection.selectedTextStart === undefined &&
    !selection.contextBefore &&
    !selection.contextAfter &&
    projection.text.indexOf(selection.selectedText, start + 1) >= 0;
  return positionMatches && !repeatedWithoutPosition
    ? { start, end: end < 0 ? projection.text.length : end }
    : undefined;
};

/** Resolve only the stored source positions, then require complete selector agreement. */
const annotationSelectionRange = (
  content: string,
  projection: VisibleProjection,
  protectedRanges: MarkdownRange[],
  selector?: SectionAnnotationTextSelector
): MarkdownRange | undefined => {
  if (!selector) return undefined;
  const start = projection.sourceIndexes.findIndex(index => index >= selector.start);
  const foundEnd = projection.sourceIndexes.findIndex(index => index >= selector.end);
  const end = foundEnd < 0 ? projection.text.length : foundEnd;
  if (start < 0 || end <= start) return undefined;
  const segments = buildMarkableSegments(
    content,
    buildSourceSegments(projection, start, end - start),
    protectedRanges
  );
  const resolved = createSectionAnnotationSelector(content, segments, projection);
  return resolved && equalAnnotationSelectors(resolved, selector) ? { start, end } : undefined;
};

const resolveCapturedNoteSelection = (
  content: string,
  projection: VisibleProjection,
  protectedRanges: MarkdownRange[],
  {
    annotationId,
    annotationSelector,
    hasExistingNote,
    selection,
  }: Pick<
    Parameters<typeof buildConversationNoteCatalog>[0],
    'annotationId' | 'annotationSelector' | 'hasExistingNote' | 'selection'
  >
) => {
  const annotationRange =
    hasExistingNote && annotationId
      ? annotationSelectionRange(content, projection, protectedRanges, annotationSelector)
      : undefined;
  return {
    selected: annotationRange ?? capturedSelectionRange(content, projection, selection),
    annotationTargetMismatch: Boolean(hasExistingNote && !annotationRange),
  };
};

const buildNoteLessonRecords = (
  content: string,
  entries: ConversationNotePassage[]
): ContextNoteRecord[] => {
  const records: ContextNoteRecord[] = [];
  let sourceCursor = 0;
  for (const entry of entries) {
    if (entry.kind === 'selection') continue;
    if (entry.selector.start > sourceCursor)
      records.push({ kind: 'context', text: content.slice(sourceCursor, entry.selector.start) });
    records.push({ id: entry.id, kind: entry.kind });
    sourceCursor = entry.selector.start;
  }
  if (sourceCursor < content.length)
    records.push({ kind: 'context', text: content.slice(sourceCursor) });
  return records;
};

/** Restore pending IDs only with the source identity carried by their assistant response. */
export const restoreConversationNotePassage = async (
  catalog: ReturnType<typeof buildConversationNoteCatalog>,
  input: { passageId?: string; selectedTextDraft?: string },
  metadata: unknown
): Promise<ReturnType<typeof validateConversationNotePassage>> => {
  if (input.passageId !== undefined) {
    const issuedSnapshot = readContextNoteSnapshotId(metadata);
    if (!issuedSnapshot)
      return {
        error: createContextNoteValidationError(
          'unknown_passage',
          catalog.entries.map(entry => entry.id)
        ),
      };
    if (issuedSnapshot !== (await catalog.snapshotId))
      return {
        error: createContextNoteValidationError('stale_context', []),
      };
  }
  return validateConversationNotePassage({
    catalog,
    input,
    current: { lessonContent: catalog.content, ...catalog.origin },
  });
};

const getBlockSentenceRanges = (
  range: MarkdownRange,
  kind: ConversationNotePassage['kind'],
  projection: VisibleProjection,
  segmenter: Intl.Segmenter
): MarkdownRange[] => {
  if (kind !== 'paragraph') return [range];
  return [...segmenter.segment(projection.text.slice(range.start, range.end))].map(sentence => ({
    start: range.start + sentence.index,
    end: range.start + sentence.index + sentence.segment.length,
  }));
};

const isVisiblePassage = (entry: ConversationNotePassage, prefixLength: number) =>
  entry.kind === 'selection' || entry.selector.end <= prefixLength;

export const buildConversationNoteCatalog = ({
  content,
  locale,
  selection,
  origin,
  annotationId,
  annotationSelector,
  hasExistingNote = Boolean(annotationId),
}: {
  content: string;
  locale: string;
  annotationId?: string;
  annotationSelector?: SectionAnnotationTextSelector;
  hasExistingNote?: boolean;
  selection?: ConversationSelectionAnchor;
  origin?: { projectId?: string; lessonId?: string };
}): {
  content: string;
  annotationId?: string;
  annotationSelector?: SectionAnnotationTextSelector;
  annotationTargetMismatch: boolean;
  hasExistingNote: boolean;
  origin?: { projectId?: string; lessonId?: string };
  entries: ConversationNotePassage[];
  records: ContextNoteRecord[];
  totalEntries: number;
  locale: string;
  snapshotId: Promise<string>;
  selectionId?: 's';
  durationMs: number;
} => {
  const started = performance.now();
  const analysis = parseMarkdownAnalysis(content);
  const projection = buildVisibleProjection(content, analysis);
  const protectedRanges = mergeOverlappingMarkdownRanges([
    ...getMarkdownAnnotationProtectedRanges(content, analysis),
    ...analysis.tableSyntaxRanges,
  ]);
  const protectedIndexes = buildProtectedProjectionIndexes(projection, protectedRanges);
  const entries: ConversationNotePassage[] = [];
  const { selected, annotationTargetMismatch } = resolveCapturedNoteSelection(
    content,
    projection,
    protectedRanges,
    { annotationId, annotationSelector, hasExistingNote, selection }
  );
  const addEntry = (start: number, end: number, kind: ConversationNotePassage['kind']) => {
    const text = projection.text.slice(start, end);
    const leading = text.length - text.trimStart().length;
    start += leading;
    end -= text.length - text.trimEnd().length;
    if (end <= start) return;
    const segments = buildMarkableSegments(
      content,
      buildSourceSegments(projection, start, end - start),
      protectedRanges
    );
    const selector = createSectionAnnotationSelector(content, segments, projection);
    if (selector?.exact !== normalizeWhitespace(projection.text.slice(start, end))) return;
    const anchor = {
      selectedText: selector.exact,
      selectedTextStart: start,
      contextBefore: selector.prefix,
      contextAfter: selector.suffix,
    };
    const updatesAnnotation = kind === 'selection' && hasExistingNote && !annotationTargetMismatch;
    entries.push({
      id: kind === 'selection' ? 's' : `p${entries.length.toString(36)}`,
      kind,
      text: selector.exact,
      anchor,
      selector,
      segments,
      content,
      origin,
      annotationId: updatesAnnotation ? annotationId : undefined,
      hasExistingNote: updatesAnnotation,
    });
  };
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  let cursor = 0;
  for (const block of analysis.noteBlocks) {
    while (cursor < projection.text.length && projection.sourceEnds[cursor] <= block.start)
      cursor++;
    const start = cursor;
    while (cursor < projection.text.length && projection.sourceIndexes[cursor] < block.end)
      cursor++;
    const end = cursor;
    const sentences = getBlockSentenceRanges({ start, end }, block.kind, projection, segmenter);
    for (const sentence of sentences) {
      for (const run of markableProjectionRuns(sentence, protectedIndexes))
        addEntry(run.start, run.end, block.kind);
    }
  }
  if (selected) addEntry(selected.start, selected.end, 'selection');
  const prefix = content.slice(0, MAX_CONTEXT_CHAT_FIELD_CHARS);
  const included = entries.filter(entry => isVisiblePassage(entry, prefix.length));
  const selectionId = included.some(entry => entry.kind === 'selection')
    ? ('s' as const)
    : undefined;
  const records = buildNoteLessonRecords(prefix, included);
  const snapshotInput = JSON.stringify([
    content,
    locale,
    selection?.selectedText,
    selection?.selectedTextStart,
    selection?.contextBefore,
    selection?.contextAfter,
    origin?.projectId,
    origin?.lessonId,
    included.map(entry => [entry.id, entry.kind, entry.selector.start, entry.selector.end]),
    ...(hasExistingNote || annotationId
      ? [{ annotationId, hasExistingNote, annotationSelector }]
      : []),
  ]);
  // Private-network HTTP is supported, where the browser's SubtleCrypto is unavailable.
  const snapshotId = Promise.resolve().then(() => bytesToHex(sha256(snapshotInput)));
  return {
    content,
    origin,
    annotationId,
    annotationSelector,
    annotationTargetMismatch,
    hasExistingNote,
    locale,
    snapshotId,
    durationMs: performance.now() - started,
    entries: included,
    records,
    selectionId,
    totalEntries: entries.length,
  };
};
