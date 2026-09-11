import { useId, useRef } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { SELF_ASSESSMENT_OPTIONS, type SelfAssessment } from './diagnosticFlow.ts';

interface Props {
  readonly title: string;
  readonly value?: SelfAssessment;
  readonly onChange: (value: SelfAssessment) => void;
  readonly active: boolean;
  readonly onActivate: (control: HTMLElement) => void;
}

export default function SelfAssessmentControl({
  title,
  value,
  onChange,
  active,
  onActivate,
}: Props) {
  const id = useId();
  const uncertainButton = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const overUncertain = useRef(false);
  const optionIndex = SELF_ASSESSMENT_OPTIONS.findIndex(option => option.value === value);
  const selected = SELF_ASSESSMENT_OPTIONS[optionIndex];
  const uncertain = value === 'uncertain';
  const selectedLabel = selected ? t(selected.label) : '';
  const label = uncertain ? t('Non so valutarmi') : selectedLabel;
  return (
    <fieldset
      className="min-w-0 max-w-xl"
      aria-label={title}
      onFocus={event => onActivate(event.currentTarget)}
      onPointerDown={event => onActivate(event.currentTarget)}
    >
      <div className="diagnostic-slider" data-uncertain={uncertain} data-empty={!value}>
        <div className="diagnostic-track">
          <div
            aria-hidden="true"
            className="diagnostic-track-fill"
            style={{
              width: uncertain
                ? '100%'
                : `${(Math.max(0, optionIndex) / (SELF_ASSESSMENT_OPTIONS.length - 1)) * 100}%`,
            }}
          />
          <div aria-hidden="true" className="diagnostic-markers">
            {SELF_ASSESSMENT_OPTIONS.map(option => (
              <span key={option.value} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={SELF_ASSESSMENT_OPTIONS.length - 1}
            step={1}
            value={Math.max(0, optionIndex)}
            aria-label={title}
            aria-valuetext={label || t('Nessuna risposta')}
            aria-describedby={`${id}-selection`}
            onPointerDown={event => {
              dragging.current = true;
              overUncertain.current = false;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              if (!dragging.current || !uncertainButton.current) return;
              const target = uncertainButton.current.getBoundingClientRect();
              // Expanding the description can move the control vertically during this drag.
              overUncertain.current = event.clientX >= target.left;
              if (overUncertain.current) onChange('uncertain');
            }}
            onPointerUp={event => {
              const next = overUncertain.current
                ? 'uncertain'
                : SELF_ASSESSMENT_OPTIONS[Number(event.currentTarget.value)].value;
              dragging.current = false;
              onChange(next);
            }}
            onPointerCancel={() => {
              dragging.current = false;
              overUncertain.current = false;
            }}
            onKeyDown={event => {
              const last = SELF_ASSESSMENT_OPTIONS.length - 1;
              const current = Math.max(0, optionIndex);
              const positions: Record<string, number> = {
                Home: 0,
                End: last,
                ArrowLeft: Math.max(0, current - 1),
                ArrowDown: Math.max(0, current - 1),
                ArrowRight: Math.min(last, current + 1),
                ArrowUp: Math.min(last, current + 1),
              };
              const next = positions[event.key];
              if (next === undefined) return;
              event.preventDefault();
              overUncertain.current = false;
              onChange(SELF_ASSESSMENT_OPTIONS[next].value);
            }}
            onChange={event => {
              // Native range change may arrive after pointerup, when dragging is already false.
              if (overUncertain.current) return;
              onChange(SELF_ASSESSMENT_OPTIONS[Number(event.target.value)].value);
            }}
          />
        </div>
        <span aria-hidden="true" className="diagnostic-slider-bridge" />
        <button
          ref={uncertainButton}
          type="button"
          className="diagnostic-uncertain"
          aria-label={t('Non so valutarmi')}
          aria-pressed={uncertain}
          onClick={() => {
            onChange('uncertain');
          }}
        >
          ?
        </button>
      </div>
      <div
        className="diagnostic-selection"
        data-selected={active && Boolean(value)}
        aria-hidden={!active || !value}
      >
        <div className="diagnostic-selection-clip">
          <div id={`${id}-selection`} className="pt-3 grid" aria-live="polite">
            {SELF_ASSESSMENT_OPTIONS.map(option => (
              <div
                key={option.value}
                aria-hidden={option.value !== value}
                style={{
                  gridArea: '1 / 1',
                  visibility: option.value === value ? 'visible' : 'hidden',
                }}
              >
                <p className="font-semibold">{t(option.label)}</p>
                <p className="mt-1 text-sm text-[var(--ink-secondary)]">{t(option.description)}</p>
              </div>
            ))}
            <p
              className="font-semibold"
              aria-hidden={!uncertain}
              style={{ gridArea: '1 / 1', visibility: uncertain ? 'visible' : 'hidden' }}
            >
              {t('Non so valutarmi')}
            </p>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
