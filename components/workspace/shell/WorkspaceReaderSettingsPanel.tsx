import OpenRouterModelPanel from '../../shared/OpenRouterModelPanel.tsx';
import type {
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
} from '../../../types.ts';

interface WorkspaceReaderSettingsPanelProps {
  modelDefaults: OpenRouterModelDefaults;
  onClose: () => void;
  onModelChange: (slot: OpenRouterModelSlot, value: string) => void;
  preferredModels: OpenRouterModelPreferences;
}

export default function WorkspaceReaderSettingsPanel({
  modelDefaults,
  onClose,
  onModelChange,
  preferredModels,
}: WorkspaceReaderSettingsPanelProps) {
  return (
    <OpenRouterModelPanel
      className="absolute right-4 top-[calc(100%+0.75rem)] z-50 w-[min(26rem,calc(100vw-2rem))]"
      defaultModels={modelDefaults}
      preferredModels={preferredModels}
      onClose={onClose}
      onModelChange={onModelChange}
    />
  );
}
