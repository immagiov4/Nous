import type { AudioPanelTab, SettingsPanelSectionId, UiPreferences } from '../../types.ts';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  normalizeVoiceProfileId,
} from '../audio/voiceProfile.ts';

export const UI_PREFERENCES_KEY = 'nous-ui-preferences';

const LEGACY_UI_PREFERENCES_KEY = 'lumina-ui-preferences';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const SETTINGS_PANEL_SECTION_IDS = new Set<SettingsPanelSectionId>(['course-notes', 'ai-models']);
const DEFAULT_SETTINGS_PANEL_EXPANDED_SECTIONS: SettingsPanelSectionId[] = ['course-notes'];

const normalizeSettingsPanelExpandedSections = (
  value: unknown
): SettingsPanelSectionId[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const expandedSections = value.filter(
    (section): section is SettingsPanelSectionId =>
      typeof section === 'string' &&
      SETTINGS_PANEL_SECTION_IDS.has(section as SettingsPanelSectionId)
  );

  return [...new Set(expandedSections)];
};

export const parseUiPreferences = (
  rawPreferences: string | null
): Partial<UiPreferences> | null => {
  if (!rawPreferences) {
    return null;
  }

  try {
    const parsedPreferences = JSON.parse(rawPreferences) as Partial<UiPreferences>;
    const nextPreferences: Partial<UiPreferences> = {};

    if (typeof parsedPreferences.isDarkMode === 'boolean') {
      nextPreferences.isDarkMode = parsedPreferences.isDarkMode;
    }

    if (
      parsedPreferences.lastAudioTab === 'voce' ||
      parsedPreferences.lastAudioTab === 'ambiente'
    ) {
      nextPreferences.lastAudioTab = parsedPreferences.lastAudioTab as AudioPanelTab;
    }

    if (typeof parsedPreferences.preferredVoice === 'string') {
      nextPreferences.preferredVoice = DEFAULT_TTS_VOICE;
    }

    if (isFiniteNumber(parsedPreferences.playbackRate)) {
      nextPreferences.playbackRate = parsedPreferences.playbackRate;
    }

    if (typeof parsedPreferences.preferredLessonModel === 'string') {
      nextPreferences.preferredLessonModel = parsedPreferences.preferredLessonModel.trim();
    }

    if (typeof parsedPreferences.preferredAssessmentModel === 'string') {
      nextPreferences.preferredAssessmentModel = parsedPreferences.preferredAssessmentModel.trim();
    }

    if (typeof parsedPreferences.preferredContextModel === 'string') {
      nextPreferences.preferredContextModel = parsedPreferences.preferredContextModel.trim();
    }

    if (typeof parsedPreferences.preferredTtsModel === 'string') {
      nextPreferences.preferredTtsModel = DEFAULT_TTS_MODEL;
    }

    if (typeof parsedPreferences.preferredTtsVoice === 'string') {
      nextPreferences.preferredTtsVoice = normalizeVoiceProfileId(
        parsedPreferences.preferredTtsVoice
      );
    } else if (typeof parsedPreferences.preferredVoice === 'string') {
      nextPreferences.preferredTtsVoice = DEFAULT_TTS_VOICE;
    }

    const expandedSettingsSections = normalizeSettingsPanelExpandedSections(
      parsedPreferences.settingsPanelExpandedSections
    );
    if (expandedSettingsSections) {
      nextPreferences.settingsPanelExpandedSections = expandedSettingsSections;
    }

    return Object.keys(nextPreferences).length > 0 ? nextPreferences : null;
  } catch {
    // intentional: fallback to default
    return null;
  }
};

export const readUiPreferences = (
  storage: Pick<Storage, 'getItem'>
): Partial<UiPreferences> | null =>
  parseUiPreferences(storage.getItem(UI_PREFERENCES_KEY)) ??
  parseUiPreferences(storage.getItem(LEGACY_UI_PREFERENCES_KEY));

export const writeUiPreferences = (
  storage: Pick<Storage, 'setItem'>,
  preferences: UiPreferences
) => {
  storage.setItem(
    UI_PREFERENCES_KEY,
    JSON.stringify({
      ...preferences,
      settingsPanelExpandedSections:
        preferences.settingsPanelExpandedSections || DEFAULT_SETTINGS_PANEL_EXPANDED_SECTIONS,
    })
  );
};
