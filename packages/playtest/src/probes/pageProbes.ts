export type ProbeSignal =
  | {
      kind: 'clipped-text';
      selector: string;
      text: string;
      scrollWidth: number;
      clientWidth: number;
    }
  | {
      kind: 'overlap';
      a: string;
      b: string;
      areaPx: number;
      covered: string[];
      onTop: string | null;
    }
  | { kind: 'horizontal-overflow'; documentWidth: number; viewportWidth: number }
  | { kind: 'layout-shift'; value: number; sources: string[]; hadRecentInput: boolean }
  | {
      kind: 'gesture-target-movement';
      selector: string;
      maxDisplacementPx: number;
      maxPointerOffsetChangePx: number;
      pointerTravelPx: number;
      gesture: 'drag' | 'press';
      animationActive: boolean;
    }
  | { kind: 'interaction-latency'; durationMs: number; eventType: string; target: string }
  | { kind: 'contrast'; selector: string; ratio: number }
  | { kind: 'console-error'; message: string };

export type ProbeWindow = typeof globalThis & {
  __playtestProbes?: { drain(): ProbeSignal[]; resetGeometry(): void };
};

/** Self-contained browser code: Playwright serializes this function for each new document. */
export function initializePageProbes(): void {
  const probeWindow = globalThis as ProbeWindow;
  if (probeWindow.__playtestProbes) return;
  const signals: ProbeSignal[] = [];
  let previousGeometry = new Set<string>();
  type Box = { left: number; top: number; right: number; bottom: number };

  function selector(element: Element): string {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const position = current.parentElement
        ? Array.from(current.parentElement.children).indexOf(current) + 1
        : 1;
      parts.unshift(`${current.localName}:nth-child(${position})`);
    }
    return parts.join(' > ');
  }

  function intersection(a: Box, b: Box): Box {
    return {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
  }

  function area(box: Box): number {
    return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  }

  function viewportBox(): Box {
    return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  }

  function visibleBox(element: Element): Box | undefined {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    let box = intersection(element.getBoundingClientRect(), viewportBox());
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      box = clipBox(box, style, rect);
      if (current === element) continue;
      if (style.overflowX !== 'visible')
        box = intersection(box, { ...box, left: rect.left, right: rect.right });
      if (style.overflowY !== 'visible')
        box = intersection(box, { ...box, top: rect.top, bottom: rect.bottom });
    }
    return area(box) > 0 ? box : undefined;
  }

  function clipBox(box: Box, style: CSSStyleDeclaration, rect: DOMRect): Box {
    const inset = /^inset\(([-\d.]+)(%|px)\)$/.exec(style.clipPath);
    if (inset) {
      // CSS inset() clips all four sides; 50% leaves an empty painted rectangle.
      const offset = Number(inset[1]);
      const horizontal = inset[2] === '%' ? (rect.width * offset) / 100 : offset;
      const vertical = inset[2] === '%' ? (rect.height * offset) / 100 : offset;
      box = intersection(box, {
        left: rect.left + horizontal,
        right: rect.right - horizontal,
        top: rect.top + vertical,
        bottom: rect.bottom - vertical,
      });
    }
    // Apps still use deprecated CSS clip for screen-reader-only text.
    const clip = style.clip;
    if (clip !== 'auto') {
      const offsets = clip.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      if (offsets?.length === 4) {
        box = intersection(box, {
          top: rect.top + offsets[0],
          right: rect.left + offsets[1],
          bottom: rect.top + offsets[2],
          left: rect.left + offsets[3],
        });
      }
    }
    return box;
  }

  type Color = { channels: number[]; alpha: number };
  function color(css: string): Color | undefined {
    const match = /^rgba?\(([^)]+)\)$/.exec(css);
    if (!match) return;
    const components = match[1].split(/[,\s/]+/).map(Number);
    return { channels: components.slice(0, 3), alpha: components[3] ?? 1 };
  }

  function composite(foreground: Color, background: number[]): number[] {
    return foreground.channels.map(
      (channel, index) => channel * foreground.alpha + background[index] * (1 - foreground.alpha)
    );
  }

  // WCAG sRGB conversion constants stay inside the serialized browser initializer.
  const srgb = {
    channelMaximum: 255,
    linearLimit: 0.04045,
    linearDivisor: 12.92,
    offset: 0.055,
    divisor: 1.055,
    exponent: 2.4,
    weights: [0.2126, 0.7152, 0.0722],
  };
  function luminance(channels: number[]): number {
    const linear = channels.map(channel => {
      const normalized = channel / srgb.channelMaximum;
      return normalized <= srgb.linearLimit
        ? normalized / srgb.linearDivisor
        : ((normalized + srgb.offset) / srgb.divisor) ** srgb.exponent;
    });
    return linear.reduce((sum, channel, index) => sum + channel * srgb.weights[index], 0);
  }

  function contrast(element: Element): number | undefined {
    const foreground = color(getComputedStyle(element).color);
    if (!foreground) return;
    const layers: Color[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      // Images and group opacity require pixel compositing; avoid inventing a computed ratio.
      if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1) return;
      const background = color(style.backgroundColor);
      if (!background) return;
      layers.push(background);
      if (background.alpha === 1) break;
    }
    let background = [255, 255, 255]; // Chromium's default document canvas.
    layers.reverse();
    for (const layer of layers) background = composite(layer, background);
    const foregroundLuminance = luminance(composite(foreground, background));
    const backgroundLuminance = luminance(background);
    return (
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
  }

  type GeometryEntry = {
    element: Element;
    box: Box;
    selector: string;
    text: string;
    overlapCandidate: boolean;
  };
  function visibleGeometry(): GeometryEntry[] {
    const interactiveSelector =
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="slider"], [role="tab"], [role="menuitem"], [tabindex]';
    return Array.from(document.querySelectorAll('*')).flatMap(element => {
      const box = visibleBox(element);
      if (!box) return [];
      const text = Array.from(element.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '')
        .join('')
        .trim();
      return [
        {
          element,
          box,
          get selector() {
            return selector(element);
          },
          text,
          overlapCandidate: Boolean(text) || element.matches(interactiveSelector),
        },
      ];
    });
  }
  function textFacts(visible: GeometryEntry[]): ProbeSignal[] {
    const facts: ProbeSignal[] = [];
    for (const entry of visible) {
      const { element, text } = entry;
      if (!text) continue;
      if (
        element.scrollWidth > element.clientWidth &&
        getComputedStyle(element).overflowX !== 'visible'
      ) {
        facts.push({
          kind: 'clipped-text',
          selector: entry.selector,
          text,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        });
      }
      const ratio = contrast(element);
      if (ratio !== undefined) facts.push({ kind: 'contrast', selector: entry.selector, ratio });
    }
    return facts;
  }
  function overlapFact(a: GeometryEntry, b: GeometryEntry): ProbeSignal | undefined {
    if (a.element.contains(b.element) || b.element.contains(a.element)) return;
    const overlap = intersection(a.box, b.box);
    const areaPx = area(overlap);
    if (areaPx <= 0) return;
    const onTop = document.elementFromPoint(
      (overlap.left + overlap.right) / 2,
      (overlap.top + overlap.bottom) / 2
    );
    const covered = onTop
      ? [a, b].filter(entry => !entry.element.contains(onTop)).map(entry => entry.selector)
      : [];
    return {
      kind: 'overlap',
      a: a.selector,
      b: b.selector,
      areaPx,
      covered,
      onTop: onTop ? selector(onTop) : null,
    };
  }
  function overlapFacts(visible: GeometryEntry[]): ProbeSignal[] {
    const facts: ProbeSignal[] = [];
    // Only text-bearing or interactive elements seed comparisons; decorative pairs are never scanned.
    for (const [index, candidate] of visible.entries()) {
      if (!candidate.overlapCandidate) continue;
      for (const [otherIndex, other] of visible.entries()) {
        if (index === otherIndex || (other.overlapCandidate && otherIndex < index)) continue;
        const [a, b] = index < otherIndex ? [candidate, other] : [other, candidate];
        const fact = overlapFact(a, b);
        if (fact) facts.push(fact);
      }
    }
    return facts;
  }
  function geometry(): ProbeSignal[] {
    const visible = visibleGeometry();
    const facts = [...textFacts(visible), ...overlapFacts(visible)];
    const documentWidth = document.documentElement.scrollWidth;
    const viewportWidth = document.documentElement.clientWidth;
    if (documentWidth > viewportWidth)
      facts.push({ kind: 'horizontal-overflow', documentWidth, viewportWidth });
    return facts;
  }

  type Gesture = {
    target: Element;
    pointerId: number;
    x: number;
    y: number;
    origin: DOMRect;
    initialOffsetX: number;
    initialOffsetY: number;
    maxDisplacementPx: number;
    maxPointerOffsetChangePx: number;
    pointerTravelPx: number;
    gesture: 'drag' | 'press';
    animationActive: boolean;
    reported?: string;
  };
  const pointerSelectors = new WeakMap<Element, string>();
  const pointerTargets: { startTime: number; selector: string }[] = [];
  let gesture: Gesture | undefined;
  let animationFrame: number | undefined;

  function sampleGesture(): void {
    if (!gesture || !visibleBox(gesture.target)) return;
    const rect = gesture.target.getBoundingClientRect();
    gesture.maxDisplacementPx = Math.max(
      gesture.maxDisplacementPx,
      Math.hypot(rect.left - gesture.origin.left, rect.top - gesture.origin.top)
    );
    gesture.maxPointerOffsetChangePx = Math.max(
      gesture.maxPointerOffsetChangePx,
      Math.hypot(
        rect.left + rect.width / 2 - gesture.x - gesture.initialOffsetX,
        rect.top + rect.height / 2 - gesture.y - gesture.initialOffsetY
      )
    );
    for (let current: Element | null = gesture.target; current; current = current.parentElement) {
      gesture.animationActive ||= current
        .getAnimations()
        .some(animation => animation.playState === 'running');
    }
  }

  function reportGesture(): void {
    sampleGesture();
    if (!gesture || !visibleBox(gesture.target)) return;
    const signal: ProbeSignal = {
      kind: 'gesture-target-movement',
      selector: selector(gesture.target),
      maxDisplacementPx: gesture.maxDisplacementPx,
      maxPointerOffsetChangePx: gesture.maxPointerOffsetChangePx,
      pointerTravelPx: gesture.pointerTravelPx,
      gesture: gesture.gesture,
      animationActive: gesture.animationActive,
    };
    const signature = JSON.stringify(signal);
    if (signature !== gesture.reported) signals.push(signal);
    gesture.reported = signature;
  }

  function tick(): void {
    sampleGesture();
    animationFrame = requestAnimationFrame(tick);
  }

  function finishGesture(event: PointerEvent): void {
    if (gesture?.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') updatePointer(event);
    reportGesture();
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    gesture = undefined;
  }

  function beginGesture(event: PointerEvent): void {
    if (event.target instanceof Element) {
      const targetSelector = selector(event.target);
      pointerSelectors.set(event.target, targetSelector);
      pointerTargets.push({ startTime: event.timeStamp, selector: targetSelector });
    }
    if (!(event.target instanceof Element) || !event.buttons || !visibleBox(event.target)) return;
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    const origin = event.target.getBoundingClientRect();
    gesture = {
      target: event.target,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin,
      initialOffsetX: origin.left + origin.width / 2 - event.clientX,
      initialOffsetY: origin.top + origin.height / 2 - event.clientY,
      maxDisplacementPx: 0,
      maxPointerOffsetChangePx: 0,
      pointerTravelPx: 0,
      gesture: 'press',
      animationActive: false,
    };
    animationFrame = requestAnimationFrame(tick);
  }
  function updatePointer(event: PointerEvent): void {
    if (!gesture) return;
    const travel = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    gesture.pointerTravelPx += travel;
    if (travel > 0) gesture.gesture = 'drag';
    gesture.x = event.clientX;
    gesture.y = event.clientY;
  }
  function moveGesture(event: PointerEvent): void {
    if (gesture?.pointerId !== event.pointerId) return;
    if (!event.buttons) {
      finishGesture(event);
      return;
    }
    updatePointer(event);
    // Frame sampling runs after the application's pointer handlers have positioned the target.
  }
  function attachListeners(): void {
    document.addEventListener('pointerdown', beginGesture, true);
    document.addEventListener('pointermove', moveGesture, true);
    document.addEventListener('pointerup', finishGesture, true);
    document.addEventListener('pointercancel', finishGesture, true);
  }
  attachListeners();
  // document.open() (including setContent) removes listeners without replacing the global object.
  new MutationObserver(attachListeners).observe(document, { childList: true });

  type ShiftEntry = PerformanceEntry & {
    value: number;
    hadRecentInput: boolean;
    sources: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
  };
  type EventEntry = PerformanceEntry & { target?: Node; targetSelector?: string };

  function recordShift(shift: ShiftEntry): void {
    const sources = shift.sources.flatMap(source => {
      const element = source.node instanceof Element ? source.node : source.node?.parentElement;
      const inViewport =
        area(intersection(source.previousRect, viewportBox())) > 0 ||
        area(intersection(source.currentRect, viewportBox())) > 0;
      return element && inViewport ? [selector(element)] : [];
    });
    if (shift.sources.length && !sources.length) return;
    signals.push({
      kind: 'layout-shift',
      value: shift.value,
      hadRecentInput: shift.hadRecentInput,
      sources,
    });
  }
  function timingTarget(timing: EventEntry): string | undefined {
    if (timing.targetSelector) return timing.targetSelector;
    if (timing.target instanceof Element)
      return pointerSelectors.get(timing.target) ?? selector(timing.target);
    if (['pointerdown', 'pointerup', 'click'].includes(timing.name)) {
      const recentTargets = pointerTargets.slice();
      recentTargets.reverse();
      return recentTargets.find(target => target.startTime <= timing.startTime)?.selector;
    }
    return undefined;
  }
  function recordTiming(timing: EventEntry): void {
    const target = timingTarget(timing);
    if (!target) return;
    signals.push({
      kind: 'interaction-latency',
      durationMs: timing.duration,
      eventType: timing.name,
      target,
    });
  }
  function recordEntries(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      if (entry.entryType === 'layout-shift') recordShift(entry as ShiftEntry);
      else recordTiming(entry as EventEntry);
    }
  }
  const observers = ['layout-shift', 'event'].map(type => {
    const observer = new PerformanceObserver(list => recordEntries(list.getEntries()));
    // Event Timing's browser-defined reporting floor is retained; this is not a finding threshold.
    observer.observe({ type, buffered: true });
    return observer;
  });

  probeWindow.__playtestProbes = {
    resetGeometry() {
      previousGeometry.clear();
    },
    drain() {
      for (const observer of observers) recordEntries(observer.takeRecords());
      reportGesture();
      const currentGeometry = new Set<string>();
      for (const signal of geometry()) {
        const signature = JSON.stringify(signal);
        currentGeometry.add(signature);
        if (!previousGeometry.has(signature)) signals.push(signal);
      }
      previousGeometry = currentGeometry;
      return signals.splice(0);
    },
  };
}
