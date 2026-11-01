import {
  COURSE_CONTROL_POSITIONS,
  type CourseControlPosition,
  type CoursePlanningControls,
} from '@shared/coursePlanningControls';
import { BookOpen, ListTree } from 'lucide-react';
import { useId } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { MarkedSlider } from '../shared/MarkedSlider.tsx';

const CONTROL_PRESENTATION = {
  depth: {
    icon: BookOpen,
    question: 'Quanto vuoi andare nel dettaglio?',
    start: 'Più pratico (con esempi e intuizioni)',
    end: 'Più teorico (con dimostrazioni e formalismi)',
  },
  granularity: {
    icon: ListTree,
    question: 'Quanto piccoli vuoi che siano gli argomenti?',
    start: 'Argomenti più ampi (visione e quadro generale)',
    end: 'Passi piccoli (un tema alla volta)',
  },
} as const;

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
    <div className="w-full divide-y divide-stone-200/70 rounded-3xl border border-gray-200 bg-white p-5 dark:border-zinc-700 dark:bg-stone-800 dark:divide-white/10">
      {(['depth', 'granularity'] as const).map(control => {
        const orderedPositions =
          control === 'granularity'
            ? [...COURSE_CONTROL_POSITIONS].reverse()
            : COURSE_CONTROL_POSITIONS;
        const position = orderedPositions.indexOf(value[control]);
        const presentation = CONTROL_PRESENTATION[control];
        const Icon = presentation.icon;
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
          const nextValue = orderedPositions[nextPosition];
          if (nextValue && nextValue !== value[control])
            onChange({ ...value, [control]: nextValue });
        };
        return (
          <div key={control} className="flex gap-3 py-5 first:pt-0 last:pb-0 sm:gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-700 sm:h-12 sm:w-12 dark:bg-orange-400/10 dark:text-orange-300">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="grid min-w-0 flex-1 gap-3">
              <label
                htmlFor={inputId}
                className="font-serif text-lg font-semibold text-gray-800 dark:text-zinc-100"
              >
                {t(CONTROL_LABELS[control])}
              </label>
              <p className="-mt-2 text-sm text-gray-500 dark:text-zinc-400">
                {t(presentation.question)}
              </p>
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
              <div className="flex justify-between gap-4 text-xs leading-5 text-gray-500 dark:text-zinc-400">
                <span className="max-w-[45%]">{t(presentation.start)}</span>
                <span className="max-w-[45%] text-right">{t(presentation.end)}</span>
              </div>
              <p id={`${inputId}-description`} className="text-sm text-gray-600 dark:text-zinc-400">
                {description}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
