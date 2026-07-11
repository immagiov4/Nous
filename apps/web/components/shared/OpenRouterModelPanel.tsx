import { ChevronDown, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { SettingsPanelSectionId } from '../../types.ts';
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
  expandedSections?: SettingsPanelSectionId[];
  onClose?: () => void;
  onSectionToggle?: (sections: SettingsPanelSectionId[]) => void;
}

export default function OpenRouterModelPanel({
  className,
  style,
  courseNotes,
  expandedSections = ['course-notes'],
  onClose,
  onSectionToggle,
}: OpenRouterModelPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);
  const shouldAnimate = useShouldAnimate();
  const expandedSectionSet = new Set(expandedSections);
  const isCourseNotesExpanded = expandedSectionSet.has('course-notes');
  const courseNotesValue = courseNotes?.value ?? '';

  const saveNotesIfChanged = useCallback(() => {
    const nextNotes = notesInputRef.current?.value ?? courseNotesValue;
    if (nextNotes === courseNotesValue) {
      return;
    }

    courseNotes?.onChange(nextNotes);
  }, [courseNotes, courseNotesValue]);

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
        saveNotesIfChanged();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose, saveNotesIfChanged]);

  useEffect(() => () => saveNotesIfChanged(), [saveNotesIfChanged]);

  return (
    <div ref={containerRef} className={className} style={style}>
      <div
        className={`model-panel-surface rounded-2xl p-4 origin-top-right ${shouldAnimate ? 'animate-[popIn_0.12s_ease]' : ''}`}
        style={{ transformOrigin: 'top right', ...style }}
      >
        <div className="max-h-[inherit] overflow-y-auto overflow-x-hidden">
          <div className="model-panel-divider flex items-center justify-between gap-4 border-b pb-3">
            <h3 className="model-panel-title text-sm font-semibold">{t('Impostazioni lettura')}</h3>
            <div className="flex items-center gap-1">
              {onClose ? (
                <button
                  type="button"
                  onClick={() => {
                    saveNotesIfChanged();
                    onClose();
                  }}
                  className="model-panel-close inline-flex h-7 w-7 items-center justify-center rounded-full"
                  title={t('Chiudi')}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>

          {courseNotes ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => toggleSection('course-notes')}
                className="model-panel-section-toggle flex w-full items-center justify-between gap-3 py-1 text-left"
                aria-expanded={isCourseNotesExpanded}
              >
                <span className="model-panel-title text-sm font-semibold">
                  {t('Istruzioni personalizzate')}
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
                    {t('Tono, livello, cose da evitare o ripetere.')}
                  </p>
                  <textarea
                    key={courseNotesValue}
                    ref={notesInputRef}
                    onBlur={saveNotesIfChanged}
                    defaultValue={courseNotesValue}
                    placeholder={
                      courseNotes.placeholder ||
                      t(
                        'Es. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico.'
                      )
                    }
                    rows={5}
                    className="model-panel-input mt-2 w-full resize-y rounded-xl px-3 py-2.5 text-sm leading-6"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
