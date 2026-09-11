import {
  CourseLanguageProficiencySchema,
  type CourseLanguageProficiency as LanguageProficiency,
} from '@shared/coursePlanningControls';
import { useId } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages';

interface CourseLanguageProficiencyProps {
  readonly language: string;
  readonly value?: LanguageProficiency;
  readonly disabled?: boolean;
  readonly onChange: (value: LanguageProficiency | undefined) => void;
}

/** A declaration for this course language, independent of subject knowledge. */
export function CourseLanguageProficiency({
  language,
  value,
  disabled,
  onChange,
}: CourseLanguageProficiencyProps) {
  const id = useId();
  const selectedLevel = value?.language === language ? value.level : '';
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium text-gray-800 dark:text-zinc-100">
        {t('Livello nella lingua del corso')} · {language}
      </label>
      <select
        id={id}
        value={selectedLevel}
        disabled={disabled}
        className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 dark:border-zinc-600 dark:bg-stone-800 dark:text-zinc-100"
        onChange={event => {
          const level = event.currentTarget.value;
          if (level === selectedLevel) return;
          onChange(level ? CourseLanguageProficiencySchema.parse({ language, level }) : undefined);
        }}
      >
        <option value="">{t('Non specificato')}</option>
        {CourseLanguageProficiencySchema.shape.level.options.map(level => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}
