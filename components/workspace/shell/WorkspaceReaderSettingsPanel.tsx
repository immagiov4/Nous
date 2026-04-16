import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
} from '../../../types.ts';
import OpenRouterModelPanel, {
  type CourseGenerationNotesBinding,
} from '../../shared/OpenRouterModelPanel.tsx';

interface WorkspaceReaderSettingsPanelProps {
  courseNotes?: CourseGenerationNotesBinding;
  modelDefaults: OpenRouterModelDefaults;
  onClose: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  preferredModels: OpenRouterModelPreferences;
}

export default function WorkspaceReaderSettingsPanel({
  courseNotes,
  modelDefaults,
  onClose,
  onModelChange,
  preferredModels,
}: WorkspaceReaderSettingsPanelProps) {
  return (
    <OpenRouterModelPanel
      className="absolute right-4 top-[calc(100%+0.75rem)] z-50 w-[min(26rem,calc(100vw-2rem))]"
      courseNotes={courseNotes}
      defaultModels={modelDefaults}
      preferredModels={preferredModels}
      onClose={onClose}
      onModelChange={onModelChange}
    />
  );
}
