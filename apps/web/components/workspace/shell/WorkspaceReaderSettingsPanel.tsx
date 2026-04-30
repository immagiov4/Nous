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
      className="absolute right-8 top-[calc(100%+0.75rem)] z-50 max-h-[calc(100dvh-6rem)] w-[min(26rem,calc(100vw-2rem))]"
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
