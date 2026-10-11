import {
  type AnimatedLessonScene,
  GUIDED_PATH_STEPS_PER_ROW,
  type GuidedPathLessonScene,
  type ProportionalLessonScene,
} from '@shared/lessonScene';
import {
  automaticDuration,
  automaticQuantity,
  PROPORTIONAL_REPLICA_LIMIT,
  proportionalResult,
  type ReadSceneAnimationFrame,
  type SceneAnimationFrame,
} from '@shared/lessonSceneAnimation';
import { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import { getAppLocale, translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { SceneIcon } from './SceneIcon.tsx';

export type { ReadSceneAnimationFrame, SceneAnimationFrame } from '@shared/lessonSceneAnimation';

function quantityRenderer(
  element: HTMLElement,
  scene: ProportionalLessonScene,
  numbers: Intl.NumberFormat
) {
  const units = Array.from(element.querySelectorAll<HTMLElement>('[data-unit]'));
  const output = element.querySelector('[data-quantity-value]');
  const formula = element.querySelector('.formula');
  const input = element.querySelector('[data-quantity-input]');
  const summary = element.querySelector('[data-quantity-summary]');
  const fill = element.querySelector<HTMLElement>('.quantity-fill');
  if (!output || !formula || !input) throw new Error('Quantity result must be mounted');
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
    output.textContent = numbers.format(proportionalResult(scene, quantity));
    formula.textContent = `${numbers.format(quantity)} × ${numbers.format(scene.amountPerUnit)} ${scene.outputUnit}`;
    input.textContent = `${scene.inputLabel}: ${numbers.format(quantity)}`;
    if (summary) summary.textContent = input.textContent;
    if (fill) fill.style.transform = `scaleX(${quantity / scene.max})`;
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
    } else if (index < 0) {
      position.textContent = t('Segui il testo');
      explanation.textContent = scene.body;
    } else {
      position.textContent = t('Tappa {step} di {count}', {
        step: index + 1,
        count: scene.steps.length,
      });
    }
    if (index >= 0) {
      explanation.textContent = scene.steps
        .filter((_, stepIndex) =>
          frame.cueTimes ? frame.cueTimes[stepIndex] === frame.cueTimes[index] : stepIndex === index
        )
        .map(step => step.detail)
        .join(' ');
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
  const locale = getAppLocale();
  const numbers = useMemo(
    () => new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }),
    [locale]
  );
  const shouldAnimate = useShouldAnimate();
  const standalonePlayback = useRef({ scene, elapsedMs: 0 });
  const staticPath = scene.type === 'guided-path' && !readFrame && !shouldAnimate;
  useEffect(() => {
    if (staticPath) return;
    const element = host.current;
    if (!element) throw new Error('Animated scene must be mounted');
    const render =
      scene.type === 'proportional'
        ? quantityRenderer(element, scene, numbers)
        : pathRenderer(element, scene);
    if (standalonePlayback.current.scene !== scene) {
      standalonePlayback.current = { scene, elapsedMs: 0 };
    }
    const standaloneClock = standalonePlayback.current;
    const durationMs = automaticDuration(scene);
    let elapsedMs = standaloneClock.elapsedMs;
    let frameId = 0;
    let lastTime: number | null = null;
    let intersecting = false;
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
      standaloneClock.elapsedMs = elapsedMs;
      render({ elapsedMs, durationMs });
      if (elapsedMs < durationMs) frameId = requestAnimationFrame(tick);
    };
    const initialFrame = readFrame ? readFrame() : { elapsedMs, durationMs };
    if (initialFrame) render(initialFrame);
    if (readFrame) {
      frameId = requestAnimationFrame(tick);
      return pause;
    }
    const updatePlayback = () => {
      pause();
      if (intersecting && scene.autoplay && !document.hidden && elapsedMs < durationMs) {
        if (!shouldAnimate) return;
        frameId = requestAnimationFrame(tick);
      }
    };
    const observer = new IntersectionObserver(entries => {
      intersecting = entries[0].isIntersecting;
      updatePlayback();
    });
    const card = element.closest('.interaction-card');
    if (!card) throw new Error('Animated scene card must be mounted');
    observer.observe(card);
    document.addEventListener('visibilitychange', updatePlayback);
    return () => {
      pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', updatePlayback);
    };
  }, [scene, readFrame, numbers, staticPath, shouldAnimate]);

  return (
    <div ref={host}>
      {scene.type === 'proportional' ? (
        <>
          <div className="quantity-layout">
            <div>
              {scene.max > PROPORTIONAL_REPLICA_LIMIT ? (
                <div className="quantity-summary">
                  <p data-quantity-summary />
                  <div className="quantity-bar" aria-hidden="true">
                    <div className="quantity-fill" />
                  </div>
                </div>
              ) : (
                <div className="replica-grid" aria-hidden="true">
                  {Array.from({ length: scene.max }, (_, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the unit number is its stable identity
                    <div key={index + 1} className="replica" data-unit={index + 1}>
                      <span className="server-symbol">
                        <SceneIcon name="server" />
                      </span>
                      <strong>
                        {numbers.format(scene.amountPerUnit)} {scene.outputUnit}
                      </strong>
                      <span>
                        {scene.unitLabel} {numbers.format(index + 1)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <output className="quantity-result">
              <span className="sr-only" data-quantity-input />
              <span>{scene.outputLabel}</span>
              <strong>
                <span data-quantity-value /> <small>{scene.outputUnit}</small>
              </strong>
              <span className="formula" />
            </output>
          </div>
          <aside className="scene-note" aria-label={t('Nota')}>
            <SceneIcon name="info-circle" />
            <p>{scene.assumption}</p>
          </aside>
        </>
      ) : null}
      {scene.type === 'guided-path' && staticPath ? (
        <ol className="path-details">
          {scene.steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored step order is fixed
            <li key={`${index}:${step.label}`}>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {scene.type === 'guided-path' && !staticPath ? (
        <>
          <ol
            className="guided-stops"
            style={{ '--path-columns': GUIDED_PATH_STEPS_PER_ROW } as CSSProperties}
          >
            {scene.steps.map((step, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: authored steps may repeat labels; their order is fixed
                key={`${index}:${step.label}`}
                data-row-turn={
                  index === GUIDED_PATH_STEPS_PER_ROW - 1 && index < scene.steps.length - 1
                    ? true
                    : undefined
                }
                data-return-row={index >= GUIDED_PATH_STEPS_PER_ROW ? true : undefined}
                style={
                  {
                    '--path-column':
                      index < GUIDED_PATH_STEPS_PER_ROW
                        ? index + 1
                        : GUIDED_PATH_STEPS_PER_ROW - (index % GUIDED_PATH_STEPS_PER_ROW),
                    '--path-row': Math.floor(index / GUIDED_PATH_STEPS_PER_ROW) + 1,
                  } as CSSProperties
                }
              >
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
      ) : null}
    </div>
  );
}
