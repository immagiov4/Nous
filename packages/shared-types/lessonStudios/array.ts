import { arrayCopy as copy, swap } from './array-algorithm.copy.it';
import { arrayTrace, calloutIndices, type ArraySpec as Spec } from './arrayAlgorithm';
import { diagram, fitLabel, format, pill, ruleOutsideSpan, textAt } from './chart';
import { chartViewport, HEIGHT, studioViewportScale, WIDTH } from './chartDimensions';
import { placeDiagramLabels } from './labelPlacement';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { ARRIVE, appear, DIM, EXIT, FOCUS, MOVE, timeline } from './motion';
import { ARRAY_LAYOUT, arrayBars } from './sortGeometry';
import { studioTextShape } from './studioTypography';
import { type StudioTimeline, setProperties } from './timeline';
import { arrayEventTimes } from './traceTiming';
import { svg, type VectorNode } from './vectorScene';

type Event = ReturnType<typeof arrayTrace>[number];
const swapRise = 131,
  swapDrop = 41;
const DISCARDED_SCALE = 0.85;
const COUNTER_ROW = 99;
const HUD_DIVIDER = 766;
const SEARCH_HEADING_BASELINE = 98;
const counterFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });

function brackets(surface: VectorNode, y: number, suffix = false, showSuffixLabel = true) {
  const group = svg(surface, 'g', {
    class: suffix ? 'settled-bracket' : 'compare-bracket',
    opacity: 0,
  });
  const span = svg(group, 'line', { x1: 0, x2: 0, y1: y, y2: y });
  const tips = [0, 1].map(() =>
    svg(group, 'line', { x1: 0, x2: 0, y1: y, y2: y + (suffix ? -9 : 11) })
  );
  const label =
    suffix && showSuffixLabel
      ? textAt(group, 0, y + 28, copy.settled, 'middle', 'settled-label')
      : null;
  return {
    group,
    move(
      play: StudioTimeline,
      left: number,
      right: number,
      opacity: number,
      time: number,
      duration: number
    ) {
      const place = (element: VectorNode, attr: Record<string, number>) =>
        play.to(element, { ...MOVE, duration, attr }, time);
      place(span, { x1: left, x2: right });
      place(tips[0], { x1: left, x2: left });
      place(tips[1], { x1: right, x2: right });
      if (label) place(label, { x: (left + right) / 2 });
      play.to(group, { ...FOCUS, attr: { opacity } }, time);
    },
  };
}

function eventFocus(event: Event) {
  if (event.focus.length) return event.focus;
  return event.kind === 'not-found' || event.kind === 'no-swap-pass'
    ? event.order
    : event.confirmed;
}

function eventLabel(event: Event, spec: Spec) {
  if (event.kind === 'swap')
    return swap(format(spec.input[event.focus[1]]), format(spec.input[event.focus[0]]));
  if (event.kind === 'compare' && ['bubble', 'insertion'].includes(spec.algorithm))
    return copy.nearby;
  if (event.kind === 'done') return copy.done;
  return spec.algorithm === 'binary-search' ? copy.titles['binary-search'] : copy.pass;
}

function searchPanel(scale: number, gap: number, target: string) {
  const font = Math.ceil(MIN_TEXT_PX / scale);
  const readouts = [copy.comparisons, ...copy.searchCompact(target).split(/\s+/u)];
  const widest = Math.max(
    ...readouts.map(text => studioTextShape(text, 'hud-label', 'middle', font).advance)
  );
  const width = Math.max(WIDTH - HUD_DIVIDER, widest + 2 * gap + 4);
  const divider = Math.max(ARRAY_LAYOUT.left + gap + 1, WIDTH - width);
  return { divider, center: (WIDTH + divider) / 2 };
}

export function buildArray(spec: Spec, root: VectorNode, beatTimesMs: number[]) {
  const events = arrayTrace(spec);
  const callouts = calloutIndices(spec, events);
  const end = Number(root.data.durationMs) / 1000;
  const times = arrayEventTimes(events, callouts, beatTimesMs, end);
  const play = timeline();
  const surface = diagram(root, copy.titles[spec.algorithm]);
  const searchMode = spec.algorithm === 'binary-search';
  const scale = root.viewport ? studioViewportScale(root.viewport) : undefined;
  const gap = scale ? MIN_TEXT_GAP_PX / scale : 0;
  const lineRoom = scale ? (MIN_TEXT_PX + MIN_TEXT_GAP_PX) / scale : 39;
  // The animated bars and brackets already show the result. Counters need room for two lines.
  const showCounters = searchMode || COUNTER_ROW >= 2 * lineRoom;
  const searchTarget = searchMode ? format(spec.target!) : undefined;
  const panel =
    scale && searchTarget !== undefined ? searchPanel(scale, gap, searchTarget) : undefined;
  const right = showCounters ? ARRAY_LAYOUT.right : WIDTH - ARRAY_LAYOUT.left;
  const layout = {
    ...ARRAY_LAYOUT,
    hud: panel?.center ?? ARRAY_LAYOUT.hud,
    right: panel ? panel.divider - gap : right,
    bottom: Math.min(ARRAY_LAYOUT.bottom, HEIGHT - lineRoom - 2 * gap),
  };
  const { slot, width, slotX, baseline, barGeometry, valueY } = arrayBars(
    spec.input,
    layout,
    lineRoom
  );

  const axisLine = svg(surface, 'line', {
    class: 'axis',
    x1: layout.left,
    x2: layout.right,
    y1: baseline,
    y2: baseline,
  });
  const tiles = spec.input.map((value, index) => {
    const tile = svg(surface, 'g', {
      class: 'array-tile',
      'data-focus': 'false',
      'data-confirmed': 'false',
    });
    setProperties(tile, { x: slotX(index) });
    const shape = svg(tile, 'g', {});
    const rect = svg(shape, 'rect', {
      class: 'array-bar',
      x: -width / 2,
      width,
      rx: 8,
      ...barGeometry(value),
    });
    textAt(tile, 0, valueY, format(value), 'middle', 'array-value');
    return { tile, rect };
  });
  const pair = brackets(surface, layout.bracket);
  const settled = brackets(
    surface,
    Math.max(layout.settled, valueY + Math.max(30, gap + 3)),
    true,
    !scale
  );
  const markers = searchMode
    ? copy.searchMarkers.map((key, index) => {
        const y = layout.bracket - (2 - index) * 28;
        const marker = svg(surface, 'g', { class: 'search-marker', opacity: 0 });
        textAt(marker, 0, y - 8, key, 'middle', 'search-label');
        svg(marker, 'line', { x1: 0, y1: y, x2: 0, y2: y + 8 });
        svg(marker, 'polyline', {
          points: [-4, y + 4, 0, y + 8, 4, y + 4].join(' '),
          fill: 'none',
          class: 'search-arrow',
        });
        return marker;
      })
    : [];

  const hud = svg(surface, 'g', { class: 'array-counters' });
  const divider = panel?.divider ?? HUD_DIVIDER;
  if (showCounters)
    svg(hud, 'line', { class: 'hud-rule', x1: divider, x2: divider, y1: 55, y2: 402 });
  const searchHeading =
    searchTarget !== undefined
      ? addSearchHeading(hud, layout.hud, searchTarget, { gap, divider })
      : undefined;
  const counterNames = searchMode ? [copy.comparisons] : [copy.comparisons, copy.swaps, copy.pass];
  const counters = (showCounters ? counterNames : []).map((name, index) => {
    const headingRows = searchHeading?.textContent.includes('\n') ? 2 : 1;
    const ordinate =
      scale && searchMode
        ? SEARCH_HEADING_BASELINE + ((headingRows + 1) * lineRoom) / 2
        : 150 + index * COUNTER_ROW;
    const numberOffset = scale && searchMode ? lineRoom : 54;
    const node = textAt(
      hud,
      layout.hud,
      ordinate + numberOffset,
      name === copy.pass ? '1' : '0',
      'middle',
      'hud-number'
    );
    textAt(hud, layout.hud, ordinate, name, 'middle', 'hud-label');
    return {
      current: name === copy.pass ? 1 : 0,
      get value() {
        return this.current;
      },
      set value(value: number) {
        this.current = value;
        node.textContent = counterFormat.format(value);
      },
    };
  });

  const overlay = svg(surface, 'g', {});
  let pairPlaced = false;
  let settledPlaced = false;
  let searchPlaced = false;
  let previousCounts = [0, 0, 1];
  const noSwapPass = events.find(event => event.kind === 'no-swap-pass')?.pass;
  const ticks = svg(surface, 'g', { class: 'compare-bracket', opacity: 1, 'aria-hidden': 'true' });
  function animateBars(event: Event, index: number, time: number, space: number) {
    const focus = eventFocus(event);
    event.order.forEach((id, position) => {
      const { tile, rect } = tiles[id];
      const discarded =
        searchMode &&
        (!event.search || position < event.search.low || position > event.search.high);
      const isFocus = focus.includes(id) && !discarded;
      play.to(
        tile,
        {
          ...FOCUS,
          duration: Math.min(FOCUS.duration, space || FOCUS.duration),
          opacity: isFocus ? 1 : DIM,
        },
        time
      );
      play.set(
        tile,
        {
          attr: {
            'data-focus': String(isFocus),
            'data-confirmed': String(event.confirmed.includes(id)),
          },
        },
        time
      );
      if (searchMode) {
        const { y, height } = barGeometry(spec.input[id]);
        const scale = discarded ? DISCARDED_SCALE : 1;
        play.to(
          rect,
          { ...MOVE, attr: { height: height * scale, y: baseline + (y - baseline) * scale } },
          time
        );
      }
      if (event.kind === 'swap' && event.focus.includes(id)) {
        const previous = events[index - 1].order.indexOf(id);
        const nextSwap = events.findIndex(
          (step, i) => i > index && step.kind === 'swap' && step.focus.includes(id)
        );
        const duration = Math.min(MOVE.duration, (times[nextSwap] ?? end) - time);
        // Slot displacement is computed from the same bar's positions before and after the swap.
        const clearance = position > previous ? -swapRise : swapDrop;
        play.to(tile, { ...MOVE, duration, x: slotX(position) }, time);
        play.to(
          tile,
          {
            duration,
            keyframes: {
              y: [0, clearance * 0.75, clearance, clearance * 0.75, 0],
              ease: MOVE.ease,
            },
          },
          time
        );
      }
    });
  }

  function animateBrackets(event: Event, time: number, space: number) {
    const focus = eventFocus(event);
    if (event.focus.length === 2) {
      const pairSlots = event.focus.map(id => event.order.indexOf(id));
      const finalComparison = event.kind === 'compare' && event.pass === noSwapPass;
      const travel = Math.min(MOVE.duration, finalComparison ? space / 2 : space);
      pair.move(
        play,
        slotX(Math.min(...pairSlots)) - width / 2,
        slotX(Math.max(...pairSlots)) + width / 2,
        1,
        time,
        pairPlaced ? travel : 0
      );
      if (finalComparison) {
        const x = slotX((pairSlots[0] + pairSlots[1]) / 2);
        const y = layout.bracket - 21;
        const tick = svg(ticks, 'g', { opacity: 0, 'data-crop-highlight': '' });
        svg(tick, 'line', { x1: x - 6, y1: y, x2: x - 2, y2: y + 4 });
        svg(tick, 'line', { x1: x - 2, y1: y + 4, x2: x + 6, y2: y - 4 });
        play.to(
          tick,
          { ...ARRIVE, duration: Math.min(ARRIVE.duration, space / 2), attr: { opacity: 1 } },
          time + travel
        );
      }
      pairPlaced = true;
    } else if (pairPlaced) play.to(pair.group, { ...EXIT, attr: { opacity: 0 } }, time);
    const confirmed = event.order.flatMap((id, position) =>
      event.confirmed.includes(id) ? [position] : []
    );
    if (confirmed.length) {
      settled.move(
        play,
        slotX(confirmed[0]) - width / 2,
        slotX(confirmed.at(-1)!) + width / 2,
        focus.some(id => event.confirmed.includes(id)) ? 1 : DIM,
        time,
        settledPlaced ? Math.min(MOVE.duration, space || MOVE.duration) : 0
      );
      settledPlaced = true;
    }
  }

  function animateSearchMarkers(event: Event, time: number) {
    if (event.search) {
      [event.search.low, event.search.mid, event.search.high].forEach((position, i) => {
        if (!searchPlaced) play.set(markers[i], { x: slotX(position), y: 8 }, time);
        play.to(
          markers[i],
          { ...(searchPlaced ? MOVE : ARRIVE), x: slotX(position), y: 0, attr: { opacity: 1 } },
          time
        );
      });
      searchPlaced = true;
    } else if (searchPlaced) {
      play.to(markers, { ...EXIT, attr: { opacity: 0 } }, time);
    }
  }

  events.forEach((event, index) => {
    const time = times[index];
    const space = Math.max(0, (times[index + 1] ?? end) - time);
    if (event.kind === 'swap') {
      const slots = event.focus.map(id => event.order.indexOf(id) * slot);
      const left = Math.min(...slots),
        right = Math.max(...slots) + slot;
      const dash = ruleOutsideSpan(0, layout.right - layout.left, left, right);
      play.set(axisLine, { attr: { 'stroke-dasharray': dash } }, time);
      play.set(
        axisLine,
        { attr: { 'stroke-dasharray': 'none' } },
        time + Math.min(MOVE.duration, space)
      );
    }
    animateBars(event, index, time, space);
    if (!searchMode) animateBrackets(event, time, space);
    animateSearchMarkers(event, time);

    const counts = [event.comparisons, event.swaps, Math.max(1, event.pass)];
    counters.forEach((counter, i) => {
      if (counts[i] === previousCounts[i]) return;
      play.to(counter, { ...MOVE, value: counts[i] }, time);
    });
    previousCounts = counts;

    if (event.kind === 'no-swap-pass') {
      play.to(ticks, { ...EXIT, attr: { opacity: 0 } }, times[index + 1]);
      const calloutIndex = callouts.indexOf(index);
      const label = calloutIndex < 0 ? undefined : copy.noSwap;
      if (label) {
        const check = pill(overlay, label, 'callout success-pill');
        check.group.data.secondaryLabel = 'true';
        const center = slotX(Math.floor(spec.input.length / 2));
        check.place([center, layout.bracket], [center, 72]);
        check.group.data.arrayEvent = String(index);
        appear(play, check.group, time, times[index + 1]);
      }
    }
  });

  callouts.forEach(index => {
    const event = events[index];
    if (event.kind === 'no-swap-pass') return;
    const label = eventLabel(event, spec);
    const involved = event.focus.length ? event.focus : event.confirmed;
    const movingId =
      event.kind === 'swap'
        ? involved.reduce((a, b) => (spec.input[a] >= spec.input[b] ? a : b), involved[0])
        : undefined;
    const positions = involved.map(id => slotX(event.order.indexOf(id)));
    let x = positions.length
      ? (Math.min(...positions) + Math.max(...positions)) / 2
      : (layout.left + layout.right) / 2;
    if (movingId !== undefined) x = slotX(events[index - 1].order.indexOf(movingId));
    const wrapper = svg(overlay, 'g', {});
    const callout = pill(wrapper, label, 'callout');
    callout.group.data.secondaryLabel = 'true';
    const targetY = searchMode ? layout.bottom : layout.bracket;
    callout.place([x, targetY], [x, searchMode ? HEIGHT - 21 : 75]);
    if (event.kind !== 'done') callout.group.data.arrayEvent = String(index);
    appear(play, callout.group, times[index], times[index + 1]);
    if (movingId !== undefined) {
      const duration = Math.min(MOVE.duration, (times[index + 1] ?? end) - times[index]);
      play.to(
        wrapper,
        { ...MOVE, duration, x: slotX(event.order.indexOf(movingId)) - x },
        times[index]
      );
    }
  });

  if (!searchMode || !scale) return play;
  return {
    cuts: play.cuts,
    seek(seconds: number, reduced?: boolean) {
      play.seek(seconds, reduced);
      placeDiagramLabels(
        surface,
        ['search-label'],
        {
          left: layout.left,
          right: layout.right,
          top: chartViewport.top,
          bottom: layout.top,
        },
        () => false
      );
    },
  };
}

function addSearchHeading(
  hud: VectorNode,
  x: number,
  target: string,
  { gap, divider }: { gap: number; divider: number }
) {
  const full = copy.search(target);
  const heading = textAt(hud, x, SEARCH_HEADING_BASELINE, full, 'middle', 'hud-label');
  if (!hud.viewport) return heading;
  const room = 2 * (Math.min(x - divider, WIDTH - x) - gap);
  if (!fitLabel(heading, full, room)) {
    if (!fitLabel(heading, copy.searchCompact(target), room) && hud.parent)
      hud.parent.data.unplacedRequiredLabel = 'true';
    heading.setAttribute('aria-label', full);
  }
  return heading;
}
