import {
  type FormulaSpotlightData,
  renderSpotlightFormula,
  renderSpotlightSymbol,
} from '@shared/formulaSpotlight';
import type { ReadSceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { memo, useEffect, useMemo, useRef } from 'react';
import 'katex/dist/katex.min.css';

/** Keeps symbol names visible and highlights the reference on the heard-voice clock. */
export const FormulaSpotlight = memo(function FormulaSpotlight({
  scene,
  readFrame,
}: {
  readonly scene: FormulaSpotlightData;
  readonly readFrame?: ReadSceneAnimationFrame;
}) {
  const host = useRef<HTMLDivElement>(null);
  const formula = useMemo(() => renderSpotlightFormula(scene), [scene]);
  const symbols = useMemo(
    () =>
      scene.symbols.map(symbol => ({
        ...symbol,
        html: renderSpotlightSymbol(symbol.latex),
      })),
    [scene.symbols]
  );
  useEffect(() => {
    const element = host.current;
    if (!element) throw new Error('Formula spotlight must be mounted');
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-formula-symbol]'));
    const terms = symbols.map(symbol =>
      Array.from(element.querySelectorAll<HTMLElement>(`.nous-formula-symbol-${symbol.id}`))
    );
    let previous: string | undefined;
    let frame = 0;
    const tick = () => {
      const current = readFrame?.();
      const active = new Set(
        current?.cueTimes?.flatMap((time, index) =>
          time <= current.elapsedMs && current.elapsedMs < (current.cueEndTimes?.[index] ?? time)
            ? [current.cueSymbolIndices?.[index] ?? index]
            : []
        ) ?? []
      );
      const selection = [...active].sort((left, right) => left - right).join(',');
      if (selection !== previous) {
        previous = selection;
        for (const [index, row] of rows.entries()) {
          const selected = active.has(index);
          row.dataset.active = String(selected);
          const definition = row.querySelector('dd');
          if (!definition) throw new Error('Symbol definition must be mounted');
          definition.hidden = !selected;
          for (const term of terms[index]) term.dataset.active = String(selected);
        }
      }
      if (readFrame) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [readFrame, symbols]);
  return (
    <div className="formula-spotlight" ref={host}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: validated KaTeX output trusts renderer-owned classes only, with authored HTML and URLs rejected. */}
      <div className="spotlight-formula" dangerouslySetInnerHTML={{ __html: formula }} />
      <dl className="spotlight-symbols">
        {symbols.map(symbol => (
          <div key={symbol.id} data-formula-symbol={symbol.id}>
            <dt>
              <span
                className="spotlight-symbol"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX escapes validated notation with trust disabled.
                dangerouslySetInnerHTML={{ __html: symbol.html }}
              />
              <span>{symbol.name}</span>
            </dt>
            <dd hidden>{symbol.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});
