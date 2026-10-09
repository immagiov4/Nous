import { buildLessonSceneDiagramSource, type LessonScene } from '@shared/lessonScene';
import { useEffect, useRef, useState } from 'react';

import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { nextMermaidRenderId, runMermaidTask } from '../../../utils/visuals/mermaidRenderer.ts';

// Below this width a flowchart runs top-down so labels keep their size instead of shrinking.
const VERTICAL_LAYOUT_MAX_WIDTH = 560;

type Mermaid = Parameters<Parameters<typeof runMermaidTask>[0]>[0];

const configureMermaid = (mermaid: Mermaid, host: HTMLElement): void => {
  const css = getComputedStyle(host);
  const token = (name: string) => css.getPropertyValue(name).trim();
  mermaid.initialize({
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
      diagramMarginY: 20,
      height: 46,
      messageMargin: 40,
      mirrorActors: false,
      useMaxWidth: false,
      width: 125,
      wrap: true,
    },
    startOnLoad: false,
    theme: 'base',
    themeCSS: `.edgeLabel .background,.edgeLabel rect{fill:${token('--surface')}!important;fill-opacity:1!important;opacity:1!important;stroke:${token('--surface')};stroke-width:8px;rx:4px;ry:4px}.messageText{paint-order:stroke;stroke:${token('--surface')};stroke-width:6px;stroke-linejoin:round}.edgePath .path,.flowchart-link{stroke-width:2px;stroke-linecap:round;stroke-linejoin:round}.node rect,.actor{rx:12px;ry:12px;stroke-width:1.5px}.messageLine0,.messageLine1{stroke-width:2px;stroke-linecap:round}.actor-line{stroke-width:1.5px}`,
    themeVariables: {
      actorBkg: token('--tint'),
      actorBorder: token('--connector-color'),
      actorLineColor: token('--connector-color'),
      actorTextColor: token('--ink'),
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
  });
};

/** Mermaid-rendered flowchart, sequence, or journey; the connection list stays available as text. */
/** `isDarkMode` only triggers a re-render: Mermaid reads the theme tokens when it draws. */
export const SceneDiagram = ({
  isDarkMode,
  scene,
}: {
  readonly isDarkMode: boolean;
  readonly scene: LessonScene;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'failed' | 'loading' | 'ready'>('loading');
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderedKey = '';
    let disposed = false;
    const render = () => {
      const width = host.getBoundingClientRect().width;
      if (!width) return;
      const direction = width < VERTICAL_LAYOUT_MAX_WIDTH ? 'TD' : 'LR';
      const key = scene.type === 'sequence' ? 'sequence' : direction;
      if (key === renderedKey) return;
      renderedKey = key;
      void runMermaidTask(async mermaid => {
        if (disposed || renderedKey !== key) return;
        try {
          configureMermaid(mermaid, host);
          const { svg } = await mermaid.render(
            nextMermaidRenderId(),
            buildLessonSceneDiagramSource(scene, direction)
          );
          if (disposed || renderedKey !== key) return;
          host.innerHTML = svg;
          const graphic = host.querySelector('svg');
          if (!graphic) return;
          graphic.setAttribute('role', 'img');
          graphic.setAttribute('aria-label', scene.title);
          graphic.style.maxWidth = 'none';
          graphic.style.width = `${graphic.viewBox.baseVal.width}px`;
          setStatus('ready');
        } catch (error) {
          console.error('Lesson scene diagram rendering failed.', error);
          if (disposed) return;
          // A previous scene's drawing must not stay visible beside this scene's text fallback.
          host.replaceChildren();
          setStatus('failed');
        }
      });
    };
    const observer = new ResizeObserver(render);
    observer.observe(host);
    render();
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [isDarkMode, scene]);

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
      <details className="diagram-description">
        <summary>{t('Leggi i collegamenti')}</summary>
        <ol>
          {diagram?.edges.map(edge => (
            <li key={`${edge.from}-${edge.to}-${edge.label}`}>
              {`${labelOf(edge.from)} → ${labelOf(edge.to)}${edge.label ? `: ${edge.label}` : ''}`}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
};
