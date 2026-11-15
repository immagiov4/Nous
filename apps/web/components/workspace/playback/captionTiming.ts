import { type FormulaSpotlightData, resolveFormulaReferences } from '@shared/formulaSpotlight';
import type { PlaybackMotionEvent, PlaybackRange } from '@shared/lessonPlayback';
import type { alignedWordTimes } from '@shared/playbackWordTiming';
import {
  type CaptionRun,
  captionAnchorSpan,
  captionMotionEvents,
  captionRangeSpan,
  type TimedMotionEvent,
} from './stageMotion.ts';

export interface CaptionTimingClock {
  runs: readonly (Pick<CaptionRun, 'start' | 'width'> & Partial<Pick<CaptionRun, 'span'>>)[];
  width: number;
  bodyDuration: number;
  headingDuration: number;
  speechRanges: readonly PlaybackRange[];
  aligned?: ReturnType<typeof alignedWordTimes>;
  seekRevision: number;
  read: () => { blockTime: number };
}
type Span = { startMs: number; endMs: number };
export const CAPTION_FILL_LEAD_SECONDS = 0.6;
interface TimingRequest {
  words?: readonly PlaybackRange[];
  anchors?: readonly string[];
  formula?: FormulaSpotlightData;
  events?: readonly PlaybackMotionEvent[];
  itemRanges?: readonly PlaybackRange[];
  visuals?: readonly { range?: PlaybackRange | null; anchors?: readonly string[] }[];
}

/** Passage-scoped acoustic timing. A new clock refreshes spans before retaining heard boundaries.
 * Range spans use absolute passage milliseconds, so paragraph progress can share this mapping.
 */
export function createCaptionTiming(speech: string, request: TimingRequest) {
  let fillBoundary = 0;
  // Presentation can complete before an acoustic boundary is eligible for retention.
  const completedWords = new Set<number>();
  let acousticSpans: (Span | undefined)[] = [];
  let spokenWord: number | undefined;
  let previous: CaptionTimingClock | undefined;
  let result: {
    spans: (Span | undefined)[];
    events: TimedMotionEvent[];
    cueTimes?: number[];
    cueEndTimes?: number[];
  } = {
    spans: [],
    events: [],
  };
  let transition:
    | { reason: 'initial' | 'refresh' | 'seek'; heardMs: number; retained: number }
    | undefined;
  return {
    read(current: CaptionTimingClock, blockTime?: number) {
      if (current === previous) return result;
      const timing = {
        speech,
        speechRanges: current.speechRanges,
        runs: current.runs,
        width: current.width,
        feather: 0,
        duration: current.bodyDuration,
        startOffset: current.headingDuration,
        aligned: current.aligned,
      };
      let spans: (Span | undefined)[] = [];
      if (request.anchors)
        spans = request.anchors.map(anchor => captionAnchorSpan({ ...timing, anchors: [anchor] }));
      if (request.formula && request.anchors) {
        spans = request.formula.symbols.map(() => ({
          startMs: Number.POSITIVE_INFINITY,
          endMs: Number.NEGATIVE_INFINITY,
        }));
        for (const reference of resolveFormulaReferences(request.formula, speech))
          spans[reference.index] = captionAnchorSpan({ ...timing, anchors: [reference.anchor] });
      }
      if (request.visuals)
        spans = request.visuals.map(({ range, anchors }) => {
          if (range) return captionRangeSpan({ ...timing, range });
          return anchors ? captionAnchorSpan({ ...timing, anchors }) : undefined;
        });
      if (request.words) spans = request.words.map(range => captionRangeSpan({ ...timing, range }));
      // Following tracks the recording, independently of retained presentation and its lead.
      acousticSpans = spans;
      let events = request.itemRanges
        ? request.itemRanges.map((range, index): TimedMotionEvent => {
            const span = captionRangeSpan({ ...timing, range });
            return {
              effect: 'focus',
              targets: [`item:${index}`],
              quote: '',
              atMs: span.startMs,
              durationMs: span.endMs - span.startMs,
              sustainFocus: true,
            };
          })
        : captionMotionEvents({ ...timing, events: request.events ?? [] });
      const heardMs = (blockTime ?? current.read().blockTime) * 1000;
      const retain = previous?.seekRevision === current.seekRevision;
      let retained = 0;
      const boundary = (before: number | undefined, next: number) => {
        if (retain && before !== undefined && before <= heardMs) {
          retained++;
          return before;
        }
        return next;
      };
      spans = spans.map(
        (span, index) =>
          span && {
            startMs: boundary(result.spans[index]?.startMs, span.startMs),
            endMs: boundary(result.spans[index]?.endMs, span.endMs),
          }
      );
      events = events.map((event, index) => {
        const before = result.events[index];
        const atMs = boundary(before?.atMs, event.atMs);
        return {
          ...event,
          atMs,
          // Preserve the pre-extraction rule, including equal onsets that are still future.
          durationMs: retain && before?.atMs === atMs ? before.durationMs : event.durationMs,
        };
      });
      let reason: 'initial' | 'refresh' | 'seek' = 'initial';
      if (retain) reason = 'refresh';
      else if (previous) reason = 'seek';
      if (current.seekRevision !== (previous?.seekRevision ?? 0)) {
        fillBoundary = heardMs / 1000;
        completedWords.clear();
      }
      transition = {
        reason,
        heardMs,
        retained,
      };
      previous = current;
      result = {
        spans,
        events,
        cueTimes: request.anchors
          ? spans.map(span => {
              if (!span) throw new Error('Anchor timing must exist');
              return span.startMs;
            })
          : undefined,
        cueEndTimes:
          request.formula && request.anchors
            ? spans.map(span => {
                if (!span) throw new Error('Formula timing must exist');
                return span.endMs;
              })
            : undefined,
      };
      return result;
    },
    /** Presentation lead never changes acoustic scene cues or advances a paused seek target. */
    fill(current: CaptionTimingClock, time = current.read().blockTime): number[] {
      const { spans } = this.read(current, time);
      spokenWord = undefined;
      for (const [index, span] of acousticSpans.entries())
        if (span && span.startMs <= time * 1000) spokenWord = index;
      if (time < 0) return spans.map(() => 0);
      const lead = Math.min(CAPTION_FILL_LEAD_SECONDS, Math.max(0, time - fillBoundary));
      const presentedMs = Math.max(0, time + lead) * 1000;
      return spans.map((span, index) => {
        if (!span) throw new Error('Caption word timing must exist');
        if (completedWords.has(index)) return 1;
        if (presentedMs >= span.endMs) {
          completedWords.add(index);
          return 1;
        }
        if (span.endMs === span.startMs) return 0;
        return Math.max(0, Math.min(1, (presentedMs - span.startMs) / (span.endMs - span.startMs)));
      });
    },
    spokenWord: () => spokenWord,
    /** Latest refresh only; no narration, word data, DOM references or accumulated history. */
    snapshot: () => transition,
  };
}
