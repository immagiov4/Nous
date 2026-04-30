import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  SettingsPanelSectionId,
} from '../../../types.ts';
import OpenRouterModelPanel, {
  type CourseGenerationNotesBinding,
} from '../../shared/OpenRouterModelPanel.tsx';

interface WorkspaceReaderSettingsPanelProps {
  courseNotes?: CourseGenerationNotesBinding;
  modelDefaults: OpenRouterModelDefaults;
  onClose: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  onSectionToggle: (sections: SettingsPanelSectionId[]) => void;
  preferredModels: OpenRouterModelPreferences;
  expandedSections: SettingsPanelSectionId[];
}

export default function WorkspaceReaderSettingsPanel({
  courseNotes,
  expandedSections,
  modelDefaults,
  onClose,
  onModelChange,
  onSectionToggle,
  preferredModels,
}: WorkspaceReaderSettingsPanelProps) {
  return (
    <OpenRouterModelPanel
      className="fixed left-1/2 top-20 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 sm:absolute sm:right-8 sm:top-[calc(100%+0.75rem)] sm:left-auto sm:translate-x-0 max-h-[calc(100dvh-6rem)]"
      courseNotes={courseNotes}
      defaultModels={modelDefaults}
      expandedSections={expandedSections}
      preferredModels={preferredModels}
      onClose={onClose}
      onModelChange={onModelChange}
      onSectionToggle={onSectionToggle}
    />
  );
}
