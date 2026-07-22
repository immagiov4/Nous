import type { SettingsPanelSectionId } from '../../../types.ts';
import OpenRouterModelPanel, {
  type CourseGenerationNotesBinding,
} from '../../shared/OpenRouterModelPanel.tsx';

interface WorkspaceReaderSettingsPanelProps {
  readonly courseNotes?: CourseGenerationNotesBinding;
  readonly onClose: () => void;
  readonly onSectionToggle: (sections: SettingsPanelSectionId[]) => void;
  readonly expandedSections: SettingsPanelSectionId[];
}

export default function WorkspaceReaderSettingsPanel({
  courseNotes,
  expandedSections,
  onClose,
  onSectionToggle,
}: WorkspaceReaderSettingsPanelProps) {
  return (
    <OpenRouterModelPanel
      className="fixed left-1/2 top-20 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 sm:absolute sm:right-8 sm:top-[calc(100%+0.75rem)] sm:left-auto sm:translate-x-0 max-h-[calc(100dvh-6rem)]"
      courseNotes={courseNotes}
      expandedSections={expandedSections}
      onClose={onClose}
      onSectionToggle={onSectionToggle}
    />
  );
}
