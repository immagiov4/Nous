import { ChevronDown, X } from 'lucide-react';
import {
  type ChangeEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  SettingsPanelSectionId,
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
  expandedSections?: SettingsPanelSectionId[];
  onClose?: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  onSectionToggle?: (sections: SettingsPanelSectionId[]) => void;
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
    slot: 'context',
    label: 'Domande rapide',
    placeholder: 'contextModel',
    value: 'preferredContextModel',
  },
];

export default function OpenRouterModelPanel({
  className,
  style,
  courseNotes,
  defaultModels,
  expandedSections = ['course-notes'],
  onClose,
  onModelChange,
  onSectionToggle,
  preferredModels,
}: OpenRouterModelPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAnimate = useShouldAnimate();
  const expandedSectionSet = new Set(expandedSections);
  const isCourseNotesExpanded = expandedSectionSet.has('course-notes');
  const isModelsExpanded = onSectionToggle ? expandedSectionSet.has('ai-models') : true;

  const [localNotes, setLocalNotes] = useState(courseNotes?.value ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const courseNotesRef = useRef(courseNotes);
  courseNotesRef.current = courseNotes;

  const handleNotesChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setLocalNotes(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      courseNotesRef.current?.onChange(value);
    }, 300);
  }, []);

  const toggleSection = (sectionId: SettingsPanelSectionId) => {
    if (!onSectionToggle) {
      return;
    }

    const nextSections = expandedSectionSet.has(sectionId)
      ? expandedSections.filter(currentSectionId => currentSectionId !== sectionId)
      : [...expandedSections, sectionId];

    onSectionToggle(nextSections);
  };

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
      <div
        className={`model-panel-surface rounded-2xl p-4 origin-top-right ${shouldAnimate ? 'animate-[popIn_0.12s_ease]' : ''}`}
        style={{ transformOrigin: 'top right', ...style }}
      >
        <div className="max-h-[inherit] overflow-y-auto overflow-x-hidden">
          <div className="model-panel-divider flex items-center justify-between gap-4 border-b pb-3">
            <h3 className="model-panel-title text-sm font-semibold">Impostazioni modelli</h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onModelChange('lesson', '');
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

          {courseNotes ? (
            <div className="model-panel-divider mt-3 border-b pb-3">
              <button
                type="button"
                onClick={() => toggleSection('course-notes')}
                className="model-panel-section-toggle flex w-full items-center justify-between gap-3 py-1 text-left"
                aria-expanded={isCourseNotesExpanded}
              >
                <span className="model-panel-title text-sm font-semibold">
                  Istruzioni personalizzate
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 transition-transform ${
                    isCourseNotesExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isCourseNotesExpanded ? (
                <label className="mt-3 block">
                  <p className="model-panel-help text-xs leading-5">
                    Tono, livello, cose da evitare o ripetere.
                  </p>
                  <textarea
                    value={localNotes}
                    onChange={handleNotesChange}
                    placeholder={
                      courseNotes.placeholder ||
                      'Es. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico.'
                    }
                    rows={5}
                    className="model-panel-input mt-2 w-full resize-y rounded-xl px-3 py-2.5 text-sm leading-6"
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          <div className={courseNotes ? 'mt-3' : 'mt-3'}>
            <button
              type="button"
              onClick={() => toggleSection('ai-models')}
              className="model-panel-section-toggle flex w-full items-center justify-between gap-3 py-1 text-left"
              aria-expanded={isModelsExpanded}
            >
              <span className="model-panel-title text-sm font-semibold">Modelli IA</span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${
                  isModelsExpanded ? 'rotate-180' : ''
                }`}
              />
            </button>

            {isModelsExpanded ? (
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
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
