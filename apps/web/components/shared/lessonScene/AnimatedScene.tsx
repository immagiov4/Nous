import type {
  AnimatedLessonScene,
  GuidedPathLessonScene,
  ProportionalLessonScene,
} from '@shared/lessonScene';
import {
  automaticDuration,
  automaticQuantity,
  proportionalResult,
} from '@shared/lessonSceneAnimation';
import { useEffect, useRef } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { SceneIcon } from './SceneIcon.tsx';

/** The lesson stage supplies its clock and complete caption cues; the reader plays gradually. */
export interface SceneAnimationFrame {
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly cueTimes?: number[];
}

export type ReadSceneAnimationFrame = () => SceneAnimationFrame | undefined;

function quantityRenderer(element: HTMLElement, scene: ProportionalLessonScene) {
  const units = Array.from(element.querySelectorAll<HTMLElement>('[data-unit]'));
  const output = element.querySelector('output');
  const formula = element.querySelector('.formula');
  if (!output || !formula) throw new Error('Quantity result must be mounted');
  let previous: number | undefined;
  return (frame: SceneAnimationFrame) => {
    const elapsed = Math.max(0, Math.min(frame.durationMs, frame.elapsedMs));
    let quantity = scene.initial;
    if (frame.cueTimes) {
      const index = frame.cueTimes.reduce(
        (last, time, cueIndex) => (time <= elapsed ? cueIndex : last),
        -1
      );
      if (index >= 0) {
        if (!scene.cues) throw new Error('Synchronized quantity cues must exist');
        quantity = scene.cues[index].value;
      }
    } else quantity = automaticQuantity({ ...scene, durationMs: frame.durationMs }, elapsed);
    if (previous === quantity) return;
    previous = quantity;
    output.textContent = proportionalResult(scene, quantity).toLocaleString('it-IT');
    formula.textContent = `${quantity} × ${scene.amountPerUnit} ${scene.outputUnit}`;
    units.forEach(unit => {
      unit.classList.toggle('present', Number(unit.dataset.unit) <= quantity);
    });
  };
}

function pathRenderer(element: HTMLElement, scene: GuidedPathLessonScene) {
  const stops = Array.from(element.querySelectorAll<HTMLElement>('[data-stop]'));
  const position = element.querySelector('.path-position');
  const explanation = element.querySelector('.path-explanation p');
  if (!position || !explanation) throw new Error('Path explanation must be mounted');
  let previous = '';
  return (frame: SceneAnimationFrame) => {
    const elapsed = Math.max(0, Math.min(frame.durationMs, frame.elapsedMs));
    const index = frame.cueTimes
      ? frame.cueTimes.reduce((last, time, cueIndex) => (time <= elapsed ? cueIndex : last), -1)
      : Math.min(
          scene.steps.length - 1,
          Math.floor((elapsed / frame.durationMs) * scene.steps.length)
        );
    const complete = elapsed === frame.durationMs;
    const key = `${index}:${complete}`;
    if (previous === key) return;
    previous = key;
    stops.forEach((stop, stopIndex) => {
      const active =
        !complete &&
        (frame.cueTimes
          ? frame.cueTimes[stopIndex] === frame.cueTimes[index]
          : stopIndex === index);
      stop.classList.toggle('current', active);
      stop.classList.toggle('visited', stopIndex < index || complete);
      if (active) stop.setAttribute('aria-current', 'step');
      else stop.removeAttribute('aria-current');
    });
    if (complete) {
      position.textContent = t('Percorso completato');
      explanation.textContent = t('La richiesta è arrivata all’archivio.');
    } else if (index < 0) {
      position.textContent = t('Segui il testo');
      explanation.textContent = scene.body;
    } else {
      position.textContent = t('Tappa {step} di {count}', {
        step: index + 1,
        count: scene.steps.length,
      });
      explanation.textContent = scene.steps[index].detail;
    }
  };
}

export function AnimatedScene({
  scene,
  readFrame,
}: {
  readonly scene: AnimatedLessonScene;
  readonly readFrame?: ReadSceneAnimationFrame;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) throw new Error('Animated scene must be mounted');
    const render =
      scene.type === 'proportional'
        ? quantityRenderer(element, scene)
        : pathRenderer(element, scene);
    const durationMs = automaticDuration(scene);
    let elapsedMs = 0;
    let frameId = 0;
    let lastTime: number | null = null;
    let started = false;
    const pause = () => {
      lastTime = null;
      cancelAnimationFrame(frameId);
    };
    const tick = (now: number) => {
      if (readFrame) {
        const frame = readFrame();
        if (frame) render(frame);
        frameId = requestAnimationFrame(tick);
        return;
      }
      if (lastTime !== null) elapsedMs = Math.min(durationMs, elapsedMs + now - lastTime);
      lastTime = now;
      render({ elapsedMs, durationMs });
      if (elapsedMs < durationMs) frameId = requestAnimationFrame(tick);
    };
    const initialFrame = readFrame ? readFrame() : { elapsedMs, durationMs };
    if (initialFrame) render(initialFrame);
    if (readFrame) {
      frameId = requestAnimationFrame(tick);
      return pause;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) {
        pause();
        return;
      }
      if (scene.autoplay && !document.hidden && elapsedMs < durationMs) {
        if (!started && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        started = true;
        pause();
        frameId = requestAnimationFrame(tick);
      }
    });
    const card = element.closest('.interaction-card');
    if (!card) throw new Error('Animated scene card must be mounted');
    observer.observe(card);
    const onVisibility = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scene, readFrame]);

  return (
    <div ref={host}>
      {scene.type === 'proportional' ? (
        <>
          <div className="quantity-layout">
            <div>
              <div className="replica-grid" aria-hidden="true">
                {Array.from({ length: scene.max }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the unit number is its stable identity
                  <div key={index + 1} className="replica" data-unit={index + 1}>
                    <span className="server-symbol">
                      <SceneIcon name="server" />
                    </span>
                    <strong>
                      {scene.amountPerUnit} {scene.outputUnit}
                    </strong>
                    <span>
                      {scene.unitLabel} {index + 1}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: the prototype status groups the result, its unit and the calculation */}
            <div className="quantity-result" role="status">
              <span>{scene.outputLabel}</span>
              <strong>
                <output /> <small>{scene.outputUnit}</small>
              </strong>
              <p className="formula" />
            </div>
          </div>
          <aside className="scene-note" aria-label={t('Nota')}>
            <SceneIcon name="info-circle" />
            <p>{scene.assumption}</p>
          </aside>
        </>
      ) : (
        <>
          <ol className="guided-stops">
            {scene.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: authored steps may repeat labels; their order is fixed
              <li key={`${index}:${step.label}`}>
                <div className="guided-stop" data-stop={index}>
                  <span className="stop-number">{index + 1}</span>
                  <strong>{step.label}</strong>
                </div>
              </li>
            ))}
          </ol>
          <div className="path-explanation" aria-live="polite">
            <span className="path-position" />
            <p />
          </div>
        </>
      )}
    </div>
  );
}
