import { normalizeVoiceProfileId } from './voiceProfile.ts';
import type { UiPreferences } from '../types.ts';

export const UI_PREFERENCES_KEY = 'lumina-ui-preferences';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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

    if (isFiniteNumber(parsedPreferences.teleprompterSpeed)) {
      nextPreferences.teleprompterSpeed = parsedPreferences.teleprompterSpeed;
    }

    if (typeof parsedPreferences.preferredVoice === 'string') {
      nextPreferences.preferredVoice = normalizeVoiceProfileId(parsedPreferences.preferredVoice);
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

    return Object.keys(nextPreferences).length > 0 ? nextPreferences : null;
  } catch {
    return null;
  }
};

export const readUiPreferences = (
  storage: Pick<Storage, 'getItem'>
): Partial<UiPreferences> | null => parseUiPreferences(storage.getItem(UI_PREFERENCES_KEY));

export const writeUiPreferences = (
  storage: Pick<Storage, 'setItem'>,
  preferences: UiPreferences
) => {
  storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
};
