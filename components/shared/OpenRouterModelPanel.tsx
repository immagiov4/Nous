import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
} from '../../types.ts';

export interface CourseGenerationNotesBinding {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface OpenRouterModelPanelProps {
  className?: string;
  courseNotes?: CourseGenerationNotesBinding;
  defaultModels: OpenRouterModelDefaults;
  onClose?: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  preferredModels: OpenRouterModelPreferences;
}

const modelFields: Array<{
  label: string;
  placeholder: keyof OpenRouterModelDefaults;
  slot: OpenRouterModelSlot;
  value: keyof OpenRouterModelPreferences;
}> = [
  {
    slot: 'lesson',
    label: 'Lezioni',
    placeholder: 'lessonModel',
    value: 'preferredLessonModel',
  },
  {
    slot: 'assessment',
    label: 'Intervista iniziale',
    placeholder: 'assessmentModel',
    value: 'preferredAssessmentModel',
  },
  {
    slot: 'context',
    label: 'Domande sul testo',
    placeholder: 'contextModel',
    value: 'preferredContextModel',
  },
];

export default function OpenRouterModelPanel({
  className,
  courseNotes,
  defaultModels,
  onClose,
  onModelChange,
  preferredModels,
}: OpenRouterModelPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onClose) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className={`rounded-2xl border border-gray-200 bg-white p-4 shadow-lg dark:border-zinc-500/60 dark:bg-stone-700 ${className ?? ''}`}
    >
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 pb-3 dark:border-zinc-500/40">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Modelli AI</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onModelChange('lesson', '');
              onModelChange('assessment', '');
              onModelChange('context', '');
            }}
            className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-500/60 dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white"
          >
            Reset
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
              title="Chiudi"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {modelFields.map(field => (
          <label key={field.slot} className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
              {field.label}
            </span>
            <input
              type="text"
              value={preferredModels[field.value]}
              onChange={event => onModelChange(field.slot, event.target.value)}
              placeholder={defaultModels[field.placeholder]}
              className="mt-1.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-500/60 dark:bg-stone-800 dark:text-white dark:focus:border-zinc-400"
            />
          </label>
        ))}
      </div>

      {courseNotes ? (
        <div className="mt-5 border-t border-gray-200 pt-4 dark:border-zinc-500/40">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
              Note di personalizzazione del corso
            </span>
            <p className="mt-1.5 text-xs leading-5 text-gray-500 dark:text-zinc-400">
              Scrivi come vuoi che siano generate le lezioni di questo corso: tono, livello di
              dettaglio, cose da evitare, cose da ripetere. Hanno priorita sullo stile di default
              quando entrano in conflitto.
            </p>
            <textarea
              value={courseNotes.value}
              onChange={event => courseNotes.onChange(event.target.value)}
              placeholder={
                courseNotes.placeholder ||
                'Es. Sono a disagio con la matematica. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico prima di andare avanti.'
              }
              rows={5}
              className="mt-2 w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-500/60 dark:bg-stone-800 dark:text-white dark:focus:border-zinc-400"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
