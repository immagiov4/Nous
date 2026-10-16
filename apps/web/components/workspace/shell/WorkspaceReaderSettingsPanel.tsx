import { RefreshCw } from 'lucide-react';
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
  return (
    <OpenRouterModelPanel
      className="pointer-events-auto fixed left-1/2 top-20 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 sm:absolute sm:right-8 sm:top-[calc(100%+0.75rem)] sm:left-auto sm:translate-x-0 max-h-[calc(100dvh-6rem)]"
      actions={
        <div className="mt-3 grid w-full">
          <button
            type="button"
            disabled={!canRegenerate}
            onClick={onRegenerate}
            title={t('Rigenera la lezione corrente')}
            className={`col-start-1 row-start-1 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-opacity duration-150 motion-reduce:transition-none ${
              !canRegenerate
                ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-500'
                : 'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600/80 dark:bg-zinc-800/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300'
            }`}
          >
            <RefreshCw className="h-4 w-4" />
            {t('Rigenera')}
          </button>
        </div>
      }
      courseNotes={courseNotes}
      expandedSections={expandedSections}
      onClose={onClose}
      onSectionToggle={onSectionToggle}
    />
  );
}
