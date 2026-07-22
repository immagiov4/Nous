// @vitest-environment jsdom

import { beforeEach, expect, test } from 'vitest';
import {
  initializeDocumentTheme,
  readInitialDarkMode,
} from '../../../services/preferences/documentTheme.ts';
import { UI_PREFERENCES_KEY } from '../../../services/preferences/uiPreferencesStorage.ts';

beforeEach(() => {
  globalThis.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

test('applies the persisted dark theme before the application renders', () => {
  globalThis.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ isDarkMode: true }));

  expect(initializeDocumentTheme(document.documentElement, globalThis.localStorage)).toBe(true);
  expect(document.documentElement).toHaveClass('dark');
  expect(readInitialDarkMode()).toBe(true);
});

test('removes a stale dark class when the persisted preference is light', () => {
  document.documentElement.classList.add('dark');
  globalThis.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ isDarkMode: false }));

  expect(initializeDocumentTheme(document.documentElement, globalThis.localStorage)).toBe(false);
  expect(document.documentElement).not.toHaveClass('dark');
});
