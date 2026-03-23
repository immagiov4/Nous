import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
} from '../types.ts';

interface OpenRouterModelPanelProps {
  className?: string;
  defaultModels: OpenRouterModelDefaults;
  onClose?: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  preferredModels: OpenRouterModelPreferences;
}

const modelFields: Array<{
  description: string;
  label: string;
  placeholder: keyof OpenRouterModelDefaults;
  slot: OpenRouterModelSlot;
  value: keyof OpenRouterModelPreferences;
}> = [
  {
    slot: 'lesson',
    label: 'Indice e lezioni',
    description: 'Usato per pianificazione, struttura e generazione delle lezioni.',
    placeholder: 'lessonModel',
    value: 'preferredLessonModel',
  },
  {
    slot: 'assessment',
    label: 'Intervista iniziale',
    description: 'Usato per la calibrazione iniziale e il profilo utente.',
    placeholder: 'assessmentModel',
    value: 'preferredAssessmentModel',
  },
  {
    slot: 'context',
    label: 'Domande sul testo',
    description: 'Usato per le risposte rapide sul brano selezionato nella pagina.',
    placeholder: 'contextModel',
    value: 'preferredContextModel',
  },
];

export default function OpenRouterModelPanel({
  className,
  defaultModels,
  onClose,
  onModelChange,
  preferredModels,
}: OpenRouterModelPanelProps) {
  return (
    <div
      className={`rounded-2xl border border-gray-200 bg-white p-4 shadow-lg dark:border-zinc-500/60 dark:bg-stone-700 ${className ?? ''}`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-3 dark:border-zinc-500/40">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Modelli AI</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-zinc-400">
            Ogni campo e opzionale. Se lo lasci vuoto uso il default previsto per quello slot.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-500/60 dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white"
          >
            Chiudi
          </button>
        ) : null}
      </div>

      <div className="mt-4 space-y-4">
        {modelFields.map(field => (
          <label key={field.slot} className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
              {field.label}
            </span>
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-500">
              {field.description}
            </span>
            <input
              type="text"
              value={preferredModels[field.value]}
              onChange={event => onModelChange(field.slot, event.target.value)}
              placeholder={defaultModels[field.placeholder]}
              className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-500/60 dark:bg-stone-800 dark:text-white dark:focus:border-zinc-400"
            />
            <p className="mt-1 text-[11px] text-gray-400 dark:text-zinc-500">
              Default: <code>{defaultModels[field.placeholder]}</code>
            </p>
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-200 pt-3 dark:border-zinc-500/40">
        <p className="text-xs text-gray-500 dark:text-zinc-400">
          I valori vengono salvati localmente e applicati per tipo di richiesta.
        </p>
        <button
          type="button"
          onClick={() => {
            onModelChange('lesson', '');
            onModelChange('assessment', '');
            onModelChange('context', '');
          }}
          className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-500/60 dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
