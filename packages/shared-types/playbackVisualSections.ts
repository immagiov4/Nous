import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  type PlaybackRange,
  resolvePlaybackNarration,
} from './lessonPlayback';
import { LESSON_SCENE_LIMITS } from './lessonScene';
import { projectMarkdownRenderingControls } from './markdownControlCharacters';

interface Node {
  type: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: Node[];
}

export interface PlaybackVisualSection {
  readonly range: PlaybackRange;
  readonly items?: readonly PlaybackRange[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Project parsed list items through the saved source map, retaining recording identity. */
export function playbackVisualSections(
  block: LessonPlaybackBlock,
  sources: readonly PlaybackContentBlock[]
): PlaybackVisualSection[] {
  block = resolvePlaybackNarration(block);
  const lists: PlaybackVisualSection[] = [];
  for (const sourceIndex of new Set(block.spans.map(span => span.sourceBlockIndex))) {
    const source = sources[sourceIndex];
    if (source?.type !== 'markdown') continue;
    const { content: markdown, sourceOffsets } = projectMarkdownRenderingControls(source.markdown);
    const projectRange = (range: NonNullable<Node['position']>): PlaybackRange | undefined => {
      const start = sourceOffsets ? sourceOffsets[range.start.offset] : range.start.offset;
      const end = sourceOffsets ? sourceOffsets[range.end.offset - 1] + 1 : range.end.offset;
      const spans = block.spans.filter(
        span =>
          span.sourceBlockIndex === sourceIndex &&
          span.source.start < end &&
          span.source.end > start &&
          span.speech.end > span.speech.start
      );
      if (!spans.length) return undefined;
      return {
        start: Math.min(
          ...spans.map(
            span =>
              span.speech.start +
              (span.math || span.fencedCode ? 0 : Math.max(0, start - span.source.start))
          )
        ),
        end: Math.max(
          ...spans.map(
            span =>
              span.speech.end -
              (span.math || span.fencedCode ? 0 : Math.max(0, span.source.end - end))
          )
        ),
      };
    };
    const visit = (node: Node): void => {
      if (node.type === 'list') {
        if ((node.children?.length ?? 0) < LESSON_SCENE_LIMITS.minItems) return;
        const items = (node.children ?? []).flatMap(item => {
          const range = item.position && projectRange(item.position);
          return range ? [range] : [];
        });
        // Individually recorded items already have their own passage and visual preparation.
        if (items.length < LESSON_SCENE_LIMITS.minItems) return;
        for (let start = 0; start < items.length; ) {
          let end = Math.min(start + LESSON_SCENE_LIMITS.items, items.length);
          const remaining = items.length - end;
          if (remaining > 0 && remaining < LESSON_SCENE_LIMITS.minItems)
            end -= LESSON_SCENE_LIMITS.minItems - remaining;
          const chunk = items.slice(start, end);
          lists.push({
            range: { start: chunk[0].start, end: chunk[chunk.length - 1].end },
            items: chunk,
          });
          start = end;
        }
        return;
      }
      if (node.children) for (const child of node.children) visit(child);
    };
    visit(parser.parse(markdown) as Node);
  }
  if (!lists.length) return [];
  const sections: PlaybackVisualSection[] = [];
  let cursor = 0;
  lists.sort((left, right) => left.range.start - right.range.start);
  for (const list of lists) {
    const prefix = block.speech.slice(cursor, list.range.start).trim();
    // A spoken heading introduces its list; it is not a separate explanatory visual.
    if (cursor === 0 && prefix === block.heading.trim()) {
      sections.push({ ...list, range: { start: 0, end: list.range.end } });
      cursor = list.range.end;
      continue;
    }
    if (prefix) sections.push({ range: { start: cursor, end: list.range.start } });
    sections.push(list);
    cursor = list.range.end;
  }
  if (block.speech.slice(cursor).trim())
    sections.push({ range: { start: cursor, end: block.speech.length } });
  return sections;
}

const visualSectionRangeIdentity = (sections: readonly PlaybackVisualSection[]) =>
  sections.map(({ range, items }) => [
    range.start,
    range.end,
    items?.map(item => [item.start, item.end]),
  ]);

/** Coverage is an exact source-map contract, independent of scene labels and provider wording. */
export function hasPreparedVisualSections(
  block: LessonPlaybackBlock,
  sources: readonly PlaybackContentBlock[]
): boolean {
  const expected = playbackVisualSections(block, sources);
  return (
    !expected.length ||
    JSON.stringify(visualSectionRangeIdentity(expected)) ===
      JSON.stringify(visualSectionRangeIdentity(block.prepared?.sections ?? []))
  );
}
