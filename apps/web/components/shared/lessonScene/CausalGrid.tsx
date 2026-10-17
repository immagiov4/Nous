import type { LessonSceneItem } from '@shared/lessonScene';
import { useLayoutEffect, useRef, useState } from 'react';

interface ConnectorGeometry {
  viewBox: string;
  stroke: number;
  paths: string[];
}

/** Numbered playback cards; connectors follow their measured row-major layout. */
export function CausalGrid({ items }: { readonly items: readonly LessonSceneItem[] }) {
  const flow = useRef<HTMLOListElement>(null);
  const [geometry, setGeometry] = useState<ConnectorGeometry | null>(null);
  useLayoutEffect(() => {
    const element = flow.current;
    if (!element) throw new Error('Causal grid must be mounted');
    const cards = items.map((_, index) => element.children[index] as HTMLElement);
    const connect = () => {
      if (!element.offsetWidth) return;
      const css = getComputedStyle(element);
      const stroke = Number.parseFloat(css.getPropertyValue('--connector-width'));
      const arrowSize = Number.parseFloat(css.getPropertyValue('--icon-size')) / 2;
      // Layout offsets exclude the stage's fit transform, so scaling cannot feed back.
      const paths = cards.slice(0, -1).map((card, index) => {
        const next = cards[index + 1];
        const sameRow = card.offsetTop === next.offsetTop;
        const endX = next.offsetLeft + (sameRow ? 0 : next.offsetWidth / 2);
        const endY = next.offsetTop + (sameRow ? next.offsetHeight / 2 : 0);
        const startX = card.offsetLeft + (sameRow ? card.offsetWidth : card.offsetWidth / 2);
        const startY = card.offsetTop + (sameRow ? card.offsetHeight / 2 : card.offsetHeight);
        const middleY = (startY + endY) / 2;
        const line = sameRow
          ? `M${startX},${startY} L${endX},${endY}`
          : `M${startX},${startY} V${middleY} H${endX} V${endY}`;
        const arrow = sameRow
          ? `M${endX - arrowSize},${endY - arrowSize / 2} L${endX},${endY} L${endX - arrowSize},${endY + arrowSize / 2}`
          : `M${endX - arrowSize / 2},${endY - arrowSize} L${endX},${endY} L${endX + arrowSize / 2},${endY - arrowSize}`;
        return `${line} ${arrow}`;
      });
      const viewBox = `0 0 ${element.offsetWidth} ${element.offsetHeight}`;
      setGeometry(previous =>
        previous?.viewBox === viewBox &&
        previous.stroke === stroke &&
        previous.paths.join(' ') === paths.join(' ')
          ? previous
          : { viewBox, stroke, paths }
      );
    };
    const observer = new ResizeObserver(connect);
    observer.observe(element);
    for (const card of cards) observer.observe(card);
    connect();
    return () => observer.disconnect();
  }, [items]);
  return (
    <div className="causal-flow">
      <ol className="causal causal-grid" ref={flow}>
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the authored sequence may repeat labels
          <li className="cause" key={`${index}-${item.label}`}>
            <span className="step-index">{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.label}</strong>
            {item.detail ? <p>{item.detail}</p> : null}
          </li>
        ))}
      </ol>
      {geometry ? (
        <svg
          className="causal-connectors"
          viewBox={geometry.viewBox}
          aria-hidden="true"
          focusable="false"
        >
          <g fill="none" stroke="currentColor" strokeWidth={geometry.stroke}>
            {geometry.paths.map((d, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one connector per adjacent authored pair
              <path className="causal-connection" key={index} d={d} />
            ))}
          </g>
        </svg>
      ) : null}
    </div>
  );
}
