import type { ContextNoteResult } from '@shared/contextNote';
import { type ContextNoteRecord, fitContextNoteView } from '@shared/contextNoteCatalog';
import type { ConversationSelectionAnchor } from '../../components/workspace/shell/types.ts';
import type { SectionAnnotationTextSelector } from '../../types.ts';
import { createSectionAnnotationSelector } from '../learning/sectionAnnotationAnchors.ts';
import { resolveSelectedSegments } from '../learning/sectionAnnotationProjection.ts';
import {
  getMarkdownAnnotationProtectedRanges,
  type MarkdownRange,
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
  return buildConversationNoteCatalog({
    content: catalog.content,
    locale: catalog.locale,
    selection: { selectedText: quote, selectedTextStart: start },
  }).entries.find(entry => entry.kind === 'selection');
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
      error: {
        status: 'validation_error',
        code: 'stale_context',
        recovery: 'refresh_context',
        availablePassageIds: [],
      },
    };
  if (target) return { target };
  if (!catalog.entries.length)
    return {
      error: {
        status: 'validation_error',
        code: 'no_annotatable_passage',
        recovery: 'unavailable',
        availablePassageIds: [],
      },
    };
  return {
    error: {
      status: 'validation_error',
      code: 'unknown_passage',
      recovery: 'choose_passage',
      availablePassageIds: catalog.entries.map(entry => entry.id),
    },
  };
};

const markableProjectionRuns = (
  projection: VisibleProjection,
  range: MarkdownRange,
  protectedRanges: MarkdownRange[]
): MarkdownRange[] => {
  const runs: MarkdownRange[] = [];
  let start = range.start;
  for (let index = range.start; index < range.end; index++) {
    if (
      !protectedRanges.some(
        r => projection.sourceIndexes[index] < r.end && projection.sourceEnds[index] > r.start
      )
    )
      continue;
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

const buildNoteLessonRecords = (
  content: string,
  entries: ConversationNotePassage[]
): ContextNoteRecord[] => {
  // The captured selection retains the existing focused-context priority; the lesson body stays in source order.
  const records: ContextNoteRecord[] = entries
    .filter(entry => entry.kind === 'selection')
    .map(entry => ({ id: entry.id, kind: entry.kind, text: entry.text }));
  let sourceCursor = 0;
  for (const entry of entries.filter(e => e.kind !== 'selection')) {
    if (entry.selector.start > sourceCursor)
      records.push({ kind: 'context', text: content.slice(sourceCursor, entry.selector.start) });
    records.push({ id: entry.id, kind: entry.kind, text: entry.text });
    sourceCursor = entry.selector.end;
  }
  if (sourceCursor < content.length)
    records.push({ kind: 'context', text: content.slice(sourceCursor) });
  return records;
};

export const buildConversationNoteCatalog = ({
  content,
  locale,
  selection,
  origin,
}: {
  content: string;
  locale: string;
  selection?: ConversationSelectionAnchor;
  origin?: { projectId?: string; lessonId?: string };
}): {
  content: string;
  origin?: { projectId?: string; lessonId?: string };
  entries: ConversationNotePassage[];
  records: ContextNoteRecord[];
  totalEntries: number;
  locale: string;
  snapshotId: string;
  durationMs: number;
} => {
  const started = performance.now();
  const snapshotId = crypto.randomUUID();
  const analysis = parseMarkdownAnalysis(content);
  const projection = buildVisibleProjection(content, analysis);
  const protectedRanges = [
    ...getMarkdownAnnotationProtectedRanges(content, analysis),
    ...analysis.tableSyntaxRanges,
  ];
  const entries: ConversationNotePassage[] = [];
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
    entries.push({
      id: `${snapshotId}:${entries.length}`,
      kind,
      text: selector.exact,
      anchor,
      selector,
      segments,
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
    const sentences =
      block.kind === 'paragraph'
        ? [...segmenter.segment(projection.text.slice(start, end))].map(s => ({
            start: start + s.index,
            end: start + s.index + s.segment.length,
          }))
        : [{ start, end }];
    for (const sentence of sentences) {
      for (const run of markableProjectionRuns(projection, sentence, protectedRanges))
        addEntry(run.start, run.end, block.kind);
    }
  }
  const selected = capturedSelectionRange(content, projection, selection);
  if (selected) addEntry(selected.start, selected.end, 'selection');
  const included = fitContextNoteView(buildNoteLessonRecords(content, entries));
  const ids = new Set(included.flatMap(r => (r.kind === 'context' ? [] : [r.id])));
  return {
    content,
    origin,
    locale,
    snapshotId,
    durationMs: performance.now() - started,
    entries: entries.filter(e => ids.has(e.id)),
    records: included,
    totalEntries: entries.length,
  };
};
