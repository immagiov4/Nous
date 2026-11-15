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
interface TimingRequest {
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
    read(current: CaptionTimingClock) {
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
      const heardMs = current.read().blockTime * 1000;
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
      if (previous) reason = retain ? 'refresh' : 'seek';
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
    /** Latest refresh only; no narration, word data, DOM references or accumulated history. */
    snapshot: () => transition,
  };
}
