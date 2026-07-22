import { useEffect, useRef } from 'react';
import {
  readUiPreferences,
  writeUiPreferences,
} from '../../services/preferences/uiPreferencesStorage.ts';
import type { UiPreferences } from '../../types.ts';

interface UseUiPreferencesPersistenceArgs {
  applyUiPreferences: (preferences: Partial<UiPreferences>) => void;
  uiPreferences: UiPreferences;
}

export const useUiPreferencesPersistence = ({
  applyUiPreferences,
  uiPreferences,
}: UseUiPreferencesPersistenceArgs) => {
  const hasHydratedFromStorageRef = useRef(false);
  const hasLoadedPreferencesRef = useRef(typeof globalThis.window === 'undefined');
  const shouldSkipNextPersistRef = useRef(true);
  const applyUiPreferencesRef = useRef(applyUiPreferences);

  useEffect(() => {
    applyUiPreferencesRef.current = applyUiPreferences;
  }, [applyUiPreferences]);

  useEffect(() => {
    if (hasHydratedFromStorageRef.current) {
      return;
    }

    hasHydratedFromStorageRef.current = true;

    if (typeof globalThis.window === 'undefined') {
      return;
    }

    const storedPreferences = readUiPreferences(globalThis.localStorage);
    if (storedPreferences) {
      applyUiPreferencesRef.current(storedPreferences);
    }

    hasLoadedPreferencesRef.current = true;
  }, []);

  useEffect(() => {
    if (!hasLoadedPreferencesRef.current || typeof globalThis.window === 'undefined') {
      return;
    }

    if (shouldSkipNextPersistRef.current) {
      shouldSkipNextPersistRef.current = false;
      return;
    }

    writeUiPreferences(globalThis.localStorage, uiPreferences);
  }, [uiPreferences]);
};
