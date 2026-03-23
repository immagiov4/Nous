import { useEffect, useRef, useState } from 'react';
import { readUiPreferences, writeUiPreferences } from '../services/uiPreferencesStorage.ts';
import type { UiPreferences } from '../types.ts';

interface UseUiPreferencesPersistenceArgs {
  applyUiPreferences: (preferences: Partial<UiPreferences>) => void;
  uiPreferences: UiPreferences;
}

export const useUiPreferencesPersistence = ({
  applyUiPreferences,
  uiPreferences,
}: UseUiPreferencesPersistenceArgs) => {
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
  const hasHydratedFromStorageRef = useRef(false);
  const applyUiPreferencesRef = useRef(applyUiPreferences);

  useEffect(() => {
    applyUiPreferencesRef.current = applyUiPreferences;
  }, [applyUiPreferences]);

  useEffect(() => {
    if (hasHydratedFromStorageRef.current) {
      return;
    }

    hasHydratedFromStorageRef.current = true;

    if (typeof window === 'undefined') {
      setHasLoadedPreferences(true);
      return;
    }

    const storedPreferences = readUiPreferences(window.localStorage);
    if (storedPreferences) {
      applyUiPreferencesRef.current(storedPreferences);
    }
    setHasLoadedPreferences(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedPreferences || typeof window === 'undefined') {
      return;
    }

    writeUiPreferences(window.localStorage, uiPreferences);
  }, [hasLoadedPreferences, uiPreferences]);
};
