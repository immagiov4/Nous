import { buildLessonSceneDiagramSource, type SceneContentData } from '@shared/lessonScene';
import { useContext, useEffect, useRef, useState } from 'react';

import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import {
  type MermaidConfiguration,
  type MermaidRenderCache,
  MermaidRenderCacheContext,
  renderConfiguredMermaid,
} from '../../../utils/visuals/mermaidRenderer.ts';

// Below this width a flowchart runs top-down so labels keep their size instead of shrinking.
const VERTICAL_LAYOUT_MAX_WIDTH = 560;
const SEQUENCE_DIAGRAM_MARGIN_Y = 20;

const diagramConfiguration = (host: HTMLElement) => {
  const css = getComputedStyle(host);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    flowchart: {
      curve: 'bumpX',
      htmlLabels: false,
      nodeSpacing: 28,
      padding: 16,
      rankSpacing: 46,
      useMaxWidth: false,
    },
    fontFamily: css.fontFamily,
    look: 'classic',
    securityLevel: 'strict',
    sequence: {
      actorMargin: 40,
      diagramMarginX: 20,
      diagramMarginY: SEQUENCE_DIAGRAM_MARGIN_Y,
      height: 46,
      messageMargin: 40,
      mirrorActors: false,
      useMaxWidth: false,
      width: 125,
      wrap: true,
    },
    startOnLoad: false,
    theme: 'base',
    themeCSS: `.edgeLabel .background,.edgeLabel rect{fill:${token('--surface')}!important;fill-opacity:1!important;opacity:1!important;stroke:${token('--surface')};stroke-width:8px;rx:4px;ry:4px}.messageText{paint-order:stroke;stroke:${token('--surface')};stroke-width:6px;stroke-linejoin:round}.edgePath .path,.flowchart-link{stroke-width:2px;stroke-linecap:round;stroke-linejoin:round}.node rect,.actor{rx:12px;ry:12px;stroke-width:1.5px}.messageLine0,.messageLine1{stroke-width:2px;stroke-linecap:round}.actor-line{stroke-width:1.5px}.sequenceNumber{fill:${token('--surface')}!important;font-weight:600}[id$="-filled-head"] path{fill:none;stroke:${token('--blue')};stroke-width:2px;stroke-linecap:round;stroke-linejoin:round}`,
    themeVariables: {
      actorBkg: token('--tint'),
      actorBorder: token('--connector-color'),
      actorLineColor: token('--connector-color'),
      actorTextColor: token('--ink'),
      // Sequence numbers sit on the message color, so they use the surface tone for contrast.
      sequenceNumberColor: token('--surface'),
      edgeLabelBackground: token('--surface'),
      fontFamily: css.fontFamily,
      fontSize: '16px',
      labelBoxBkgColor: token('--surface'),
      labelTextColor: token('--ink'),
      lineColor: token('--connector-color'),
      noteBkgColor: token('--tint'),
      primaryBorderColor: token('--connector-color'),
      primaryColor: token('--tint'),
      primaryTextColor: token('--ink'),
      secondaryColor: token('--surface'),
      signalColor: token('--blue'),
      signalTextColor: token('--ink'),
      tertiaryColor: token('--paper'),
    },
  } satisfies MermaidConfiguration;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// Open asynchronous arrowheads drawn at the same scale as the other message tips.
const OPEN_ARROWHEAD = {
  markerHeight: '10',
  markerUnits: 'userSpaceOnUse',
  markerWidth: '14',
  refX: '18',
  refY: '7',
  viewBox: '0 0 20 14',
} as const;
const OPEN_ARROWHEAD_PATH = 'M9 1 L18 7 L9 13';
const MESSAGE_LABEL_PADDING = { x: 4, y: 3 } as const;
const MESSAGE_LABEL_RADIUS = '4';

/** Bound sequence lifelines to their messages and refine arrowheads and label surfaces. */
const refineSequenceGraphic = (graphic: SVGSVGElement, surface: string): void => {
  const messages = Array.from(
    graphic.querySelectorAll<SVGGraphicsElement>('.messageLine0, .messageLine1')
  );
  if (!messages.length) throw new Error('A sequence drawing must contain message paths.');
  const lastMessageBottom = Math.max(
    ...messages.map(message => {
      const box = message.getBBox();
      return box.y + box.height;
    })
  );
  const lifelineBottom = lastMessageBottom + SEQUENCE_DIAGRAM_MARGIN_Y;
  for (const line of graphic.querySelectorAll('.actor-line')) {
    line.setAttribute('y2', String(lifelineBottom));
  }
  const viewBox = graphic.viewBox.baseVal;
  viewBox.height = lifelineBottom + SEQUENCE_DIAGRAM_MARGIN_Y - viewBox.y;
  graphic.setAttribute('height', String(viewBox.height));
  for (const marker of graphic.querySelectorAll('marker[id$="-filled-head"]')) {
    for (const [name, value] of Object.entries(OPEN_ARROWHEAD)) marker.setAttribute(name, value);
    marker.querySelector('path')?.setAttribute('d', OPEN_ARROWHEAD_PATH);
  }
  // A message label needs an opaque surface across its whole text box, including spaces.
  for (const text of graphic.querySelectorAll<SVGTextElement>('.messageText')) {
    const box = text.getBBox();
    const background = document.createElementNS(SVG_NAMESPACE, 'rect');
    background.setAttribute('x', String(box.x - MESSAGE_LABEL_PADDING.x));
    background.setAttribute('y', String(box.y - MESSAGE_LABEL_PADDING.y));
    background.setAttribute('width', String(box.width + 2 * MESSAGE_LABEL_PADDING.x));
    background.setAttribute('height', String(box.height + 2 * MESSAGE_LABEL_PADDING.y));
    background.setAttribute('rx', MESSAGE_LABEL_RADIUS);
    background.setAttribute('fill', surface);
    text.before(background);
  }
};

/** Caches the complete scene drawing, including sequence layout, before it becomes visible. */
const renderSceneDiagram = async ({
  scene,
  direction,
  host,
  cache,
  signal,
}: {
  scene: SceneContentData;
  direction: 'LR' | 'TD';
  host: HTMLElement;
  cache: MermaidRenderCache | null;
  signal?: AbortSignal;
}): Promise<string> => {
  signal?.throwIfAborted();
  const code = buildLessonSceneDiagramSource(scene, direction);
  const configuration = diagramConfiguration(host);
  const surfaceColor = configuration.themeVariables.secondaryColor;
  const key = JSON.stringify(['scene', code, configuration]);
  let drawing = cache?.get(key);
  if (!drawing) {
    drawing = renderConfiguredMermaid({
      code,
      configuration,
      cache,
      signal: cache ? undefined : signal,
    }).then(svg => {
      if (scene.type !== 'sequence') return svg;
      const surface = document.createElement('div');
      Object.assign(surface.style, {
        position: 'absolute',
        visibility: 'hidden',
        fontFamily: configuration.fontFamily,
        fontSize: configuration.themeVariables.fontSize,
      });
      surface.innerHTML = svg;
      // Shared preparation must retain SVG layout even if its first view is retired.
      document.body.append(surface);
      try {
        const graphic = surface.querySelector('svg');
        if (!graphic) throw new Error('A scene drawing must contain an SVG.');
        refineSequenceGraphic(graphic, surfaceColor);
        return graphic.outerHTML;
      } finally {
        surface.remove();
      }
    });
    cache?.set(key, drawing);
    const request = drawing;
    void drawing.catch(() => {
      if (cache?.get(key) === request) cache.delete(key);
    });
  }
  const svg = await drawing;
  signal?.throwIfAborted();
  return svg;
};

/** Prepares both responsive layouts while narration is paused, using the scene's own theme. */
export async function prepareSceneDiagrams({
  scenes,
  parent,
  cache,
  signal,
}: {
  scenes: readonly SceneContentData[];
  parent: HTMLElement;
  cache: MermaidRenderCache;
  signal: AbortSignal;
}): Promise<void> {
  signal.throwIfAborted();
  if (!scenes.length) return;
  const scope = document.createElement('div');
  scope.className = 'lesson-scene lesson-scene-bare';
  Object.assign(scope.style, { position: 'absolute', visibility: 'hidden' });
  parent.append(scope);
  try {
    const configuration = diagramConfiguration(scope);
    const codes = scenes.flatMap(scene =>
      (['LR', 'TD'] as const).map(direction => buildLessonSceneDiagramSource(scene, direction))
    );
    await document.fonts.load(
      `${configuration.themeVariables.fontSize} ${configuration.fontFamily}`,
      [...codes].join(' ')
    );
    for (const scene of scenes)
      for (const direction of ['LR', 'TD'] as const) {
        signal.throwIfAborted();
        try {
          await renderSceneDiagram({ scene, direction, host: scope, cache, signal });
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          console.error('Lesson scene diagram preparation failed.', error);
        }
      }
  } finally {
    scope.remove();
  }
}

/** Mermaid-rendered flowchart, sequence, or journey; the connection list stays available as text. */
/** `isDarkMode` only triggers a re-render: Mermaid reads the theme tokens when it draws. */
export const SceneDiagram = ({
  isDarkMode,
  scene,
}: {
  readonly isDarkMode: boolean;
  readonly scene: SceneContentData;
}) => {
  const cache = useContext(MermaidRenderCacheContext);
  const hostRef = useRef<HTMLDivElement>(null);
  const renderedSceneRef = useRef<SceneContentData | null>(null);
  const [status, setStatus] = useState<'failed' | 'loading' | 'ready'>('loading');
  // biome-ignore lint/correctness/useExhaustiveDependencies: A theme change replaces the inherited DOM tokens read by this effect.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderedKey = '';
    let disposed = false;
    let request: AbortController | undefined;
    // A new scene must not show the previous scene's drawing while its own render is queued.
    if (renderedSceneRef.current !== scene) host.replaceChildren();
    renderedSceneRef.current = scene;
    const render = () => {
      const width = host.getBoundingClientRect().width;
      if (!width) return;
      const direction = width < VERTICAL_LAYOUT_MAX_WIDTH ? 'TD' : 'LR';
      const key = scene.type === 'sequence' ? 'sequence' : direction;
      if (key === renderedKey) return;
      renderedKey = key;
      request?.abort();
      const current = new AbortController();
      request = current;
      renderSceneDiagram({ scene, direction, host, cache, signal: current.signal })
        .then(svg => {
          if (disposed || renderedKey !== key) return;
          host.innerHTML = svg;
          const graphic = host.querySelector('svg');
          if (!graphic) return;
          graphic.setAttribute('role', 'img');
          graphic.setAttribute('aria-label', scene.title);
          // Wide diagrams scale down to the scene width instead of overflowing it.
          graphic.style.maxWidth = '100%';
          graphic.style.width = `${graphic.viewBox.baseVal.width}px`;
          setStatus('ready');
        })
        .catch(error => {
          if (disposed || current.signal.aborted) return;
          console.error('Lesson scene diagram rendering failed.', error);
          host.replaceChildren();
          setStatus('failed');
        });
    };
    const observer = new ResizeObserver(render);
    observer.observe(host);
    render();
    return () => {
      disposed = true;
      request?.abort();
      observer.disconnect();
    };
  }, [cache, isDarkMode, scene]);

  const diagram = scene.diagram;
  const labelOf = (id: string) => diagram?.nodes.find(node => node.id === id)?.label ?? id;
  return (
    <>
      <section
        aria-label={`${t('Diagramma')}: ${scene.title}`}
        className="diagram-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: wide diagrams scroll, so keyboard users must reach the region
        tabIndex={0}
      >
        {/* Mermaid owns this element's children, so React never renders into it. */}
        <div ref={hostRef} className="mermaid-diagram" />
        {status === 'ready' ? null : (
          <p>
            {status === 'failed'
              ? t('Il diagramma non è disponibile. Puoi leggere i collegamenti nella descrizione.')
              : t('Composizione del diagramma…')}
          </p>
        )}
      </section>
      <div className={`diagram-description${status === 'failed' ? '' : ' sr-only'}`}>
        <ol>
          {diagram?.edges.map((edge, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: repeated messages are valid; the list is static
            <li key={`${index}-${edge.from}-${edge.to}-${edge.label}`}>
              {`${labelOf(edge.from)} → ${labelOf(edge.to)}`}
              {edge.label ? `: ${edge.label}` : null}
            </li>
          ))}
        </ol>
      </div>
    </>
  );
};
