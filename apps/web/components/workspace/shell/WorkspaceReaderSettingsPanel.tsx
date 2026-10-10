import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { SettingsPanelSectionId } from '../../../types.ts';
import OpenRouterModelPanel, {
  type CourseGenerationNotesBinding,
} from '../../shared/OpenRouterModelPanel.tsx';

interface WorkspaceReaderSettingsPanelProps {
  readonly canRegenerate: boolean;
  readonly onRegenerate: () => void;
  readonly courseNotes?: CourseGenerationNotesBinding;
  readonly onClose: () => void;
  readonly onSectionToggle: (sections: SettingsPanelSectionId[]) => void;
  readonly expandedSections: SettingsPanelSectionId[];
}

export default function WorkspaceReaderSettingsPanel({
  canRegenerate,
  onRegenerate,
  courseNotes,
  expandedSections,
  onClose,
  onSectionToggle,
}: WorkspaceReaderSettingsPanelProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocusRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isConfirmationVisible = isConfirming && canRegenerate;

  const cancelRegeneration = () => {
    restoreTriggerFocusRef.current = true;
    setIsConfirming(false);
  };

  useEffect(() => {
    if (!isConfirmationVisible) {
      if (restoreTriggerFocusRef.current) {
        triggerRef.current?.focus();
        restoreTriggerFocusRef.current = false;
      }
      return;
    }
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      restoreTriggerFocusRef.current = true;
      setIsConfirming(false);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isConfirmationVisible]);

  return (
    <OpenRouterModelPanel
      className="pointer-events-auto fixed left-1/2 top-20 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 sm:absolute sm:right-8 sm:top-[calc(100%+0.75rem)] sm:left-auto sm:translate-x-0 max-h-[calc(100dvh-6rem)]"
      actions={
        <div className="mt-3 grid w-full">
          <button
            ref={triggerRef}
            type="button"
            disabled={!canRegenerate}
            inert={isConfirmationVisible}
            aria-hidden={isConfirmationVisible}
            onClick={() => setIsConfirming(true)}
            title={t('Rigenera la lezione corrente')}
            className={`col-start-1 row-start-1 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-opacity duration-150 motion-reduce:transition-none ${
              isConfirmationVisible ? 'pointer-events-none opacity-0' : 'opacity-100'
            } ${
              !canRegenerate
                ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-500'
                : 'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300'
            }`}
          >
            <RefreshCw className="h-4 w-4" />
            {t('Rigenera')}
          </button>
          <fieldset
            aria-label={t('Rigenerare questa lezione?')}
            aria-hidden={!isConfirmationVisible}
            inert={!isConfirmationVisible}
            className={`col-start-1 row-start-1 flex min-w-0 items-center justify-between gap-1 text-xs transition-opacity duration-150 motion-reduce:transition-none ${
              isConfirmationVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <span className="min-w-0 font-semibold text-stone-900 dark:text-stone-100">
              {t('Rigenerare questa lezione?')}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                ref={cancelRef}
                type="button"
                onClick={cancelRegeneration}
                className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                {t('No')}
              </button>
              <button
                type="button"
                disabled={!canRegenerate}
                onClick={() => {
                  setIsConfirming(false);
                  onRegenerate();
                }}
                className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
              >
                {t('Sì, rigenera')}
              </button>
            </div>
          </fieldset>
        </div>
      }
      courseNotes={courseNotes}
      expandedSections={expandedSections}
      onClose={onClose}
      onSectionToggle={onSectionToggle}
    />
  );
}
