import {
  COURSE_CONTROL_POSITIONS,
  type CourseControlPosition,
  type CoursePlanningControls,
} from '@shared/coursePlanningControls';
import { useId } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { MarkedSlider } from '../shared/MarkedSlider.tsx';

const CONTROL_LABELS = {
  depth: 'Approfondimento',
  granularity: 'Granularità',
} as const;

const getControlDescriptions = () =>
  ({
    depth: {
      'much-less': t('Molto più essenziale'),
      less: t('Più essenziale'),
      auto: t('Auto'),
      more: t('Più approfondito'),
      'much-more': t('Molto più approfondito'),
    },
    granularity: {
      'much-less': t('Passaggi molto più piccoli'),
      less: t('Passaggi più piccoli'),
      auto: t('Auto'),
      more: t('Lezioni più corpose'),
      'much-more': t('Lezioni molto più corpose'),
    },
  }) as const satisfies Record<keyof CoursePlanningControls, Record<CourseControlPosition, string>>;

interface CourseControlsProps {
  readonly value: CoursePlanningControls;
  readonly hasReferenceMaterial: boolean;
  readonly disabled?: boolean;
  readonly onChange: (controls: CoursePlanningControls) => void;
}

export function describeCourseControls(value: CoursePlanningControls): string {
  const descriptions = getControlDescriptions();
  return `${t(CONTROL_LABELS.depth)}: ${descriptions.depth[value.depth]}. ${t(CONTROL_LABELS.granularity)}: ${descriptions.granularity[value.granularity]}.`;
}

/** Course-local choices remain independent of subject expertise and the learning goal. */
export function CourseControls({
  value,
  hasReferenceMaterial,
  disabled,
  onChange,
}: CourseControlsProps) {
  const id = useId();
  const descriptions = getControlDescriptions();
  return (
    <div className="grid w-full gap-7 rounded-3xl border border-gray-200 bg-white p-5 dark:border-zinc-700 dark:bg-stone-800">
      {(['depth', 'granularity'] as const).map(control => {
        const position = COURSE_CONTROL_POSITIONS.indexOf(value[control]);
        const baseline = hasReferenceMaterial ? t('Come il materiale') : t('Bilanciato');
        const relative = hasReferenceMaterial
          ? t('Rispetto al materiale')
          : t('Rispetto al bilanciato');
        const description =
          value[control] === 'auto'
            ? `${t('Auto')} · ${baseline}`
            : `${descriptions[control][value[control]]} · ${relative}`;
        const inputId = `${id}-${control}`;
        const updatePosition = (nextPosition: number) => {
          const nextValue = COURSE_CONTROL_POSITIONS[nextPosition];
          if (nextValue && nextValue !== value[control])
            onChange({ ...value, [control]: nextValue });
        };
        return (
          <div key={control} className="grid gap-3">
            <label
              htmlFor={inputId}
              className="text-sm font-medium text-gray-800 dark:text-zinc-100"
            >
              {t(CONTROL_LABELS[control])}
            </label>
            <MarkedSlider
              id={inputId}
              aria-describedby={`${inputId}-description`}
              aria-valuetext={description}
              min={0}
              max={COURSE_CONTROL_POSITIONS.length - 1}
              step={1}
              value={position}
              markerCount={COURSE_CONTROL_POSITIONS.length}
              disabled={disabled}
              onChange={event => updatePosition(Number.parseInt(event.currentTarget.value, 10))}
            />
            <p id={`${inputId}-description`} className="text-sm text-gray-600 dark:text-zinc-400">
              {description}
            </p>
          </div>
        );
      })}
    </div>
  );
}
