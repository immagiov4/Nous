import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { type CSSProperties, useEffect, useRef } from 'react';
import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
} from '../../types.ts';
import { useShouldAnimate } from '../../utils/motion/useShouldAnimate.ts';

export interface CourseGenerationNotesBinding {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface OpenRouterModelPanelProps {
  className?: string;
  style?: CSSProperties;
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
  style,
  courseNotes,
  defaultModels,
  onClose,
  onModelChange,
  preferredModels,
}: OpenRouterModelPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAnimate = useShouldAnimate();

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
    <div ref={containerRef} className={className} style={style}>
      <motion.div
        initial={shouldAnimate ? { opacity: 0, scale: 0.94 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{
          opacity: { duration: 0.09, ease: [0.2, 0.85, 0.25, 1] },
          scale: { type: 'spring', stiffness: 480, damping: 28, mass: 0.7 },
        }}
        style={{ transformOrigin: 'top right', willChange: 'transform, opacity' }}
        className="model-panel-surface rounded-2xl p-4"
      >
        <div className="model-panel-divider flex items-center justify-between gap-4 border-b pb-3">
          <h3 className="model-panel-title text-sm font-semibold">Modelli AI</h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onModelChange('lesson', '');
                onModelChange('assessment', '');
                onModelChange('context', '');
              }}
              className="model-panel-reset rounded-full px-2.5 py-1 text-xs font-medium"
            >
              Reset
            </button>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="model-panel-close inline-flex h-7 w-7 items-center justify-center rounded-full"
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
              <span className="model-panel-label block text-[11px] font-semibold uppercase tracking-[0.18em]">
                {field.label}
              </span>
              <input
                type="text"
                value={preferredModels[field.value]}
                onChange={event => onModelChange(field.slot, event.target.value)}
                placeholder={defaultModels[field.placeholder]}
                className="model-panel-input mt-1.5 w-full rounded-xl px-3 py-2.5 text-sm"
              />
            </label>
          ))}
        </div>

        {courseNotes ? (
          <div className="model-panel-divider mt-5 border-t pt-4">
            <label className="block">
              <span className="model-panel-label block text-[11px] font-semibold uppercase tracking-[0.18em]">
                Note di personalizzazione del corso
              </span>
              <p className="model-panel-help mt-1.5 text-xs leading-5">
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
                className="model-panel-input mt-2 w-full resize-y rounded-xl px-3 py-2.5 text-sm leading-6"
              />
            </label>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
