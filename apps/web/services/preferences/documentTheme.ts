import { readUiPreferences } from './uiPreferencesStorage.ts';

const readStoredDarkMode = (storage: Pick<Storage, 'getItem'>): boolean | null => {
  try {
    const preference = readUiPreferences(storage)?.isDarkMode;
    return typeof preference === 'boolean' ? preference : null;
  } catch {
    return null;
  }
};

export const initializeDocumentTheme = (
  root: Pick<HTMLElement, 'classList'>,
  storage: Pick<Storage, 'getItem'>
): boolean => {
  const isDarkMode = readStoredDarkMode(storage) ?? root.classList.contains('dark');
  root.classList.toggle('dark', isDarkMode);
  return isDarkMode;
};

export const readInitialDarkMode = (): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }

  if (typeof globalThis.window === 'undefined') {
    return document.documentElement.classList.contains('dark');
  }

  return (
    readStoredDarkMode(globalThis.localStorage) ??
    document.documentElement.classList.contains('dark')
  );
};
