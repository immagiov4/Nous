import { useSyncExternalStore } from 'react';
import { getAppLocale, subscribeToAppLocale } from '../i18n/uiMessages.ts';

/** Subscribes translated render boundaries, including memoized reader components. */
export const useAppLocale = () =>
  useSyncExternalStore(subscribeToAppLocale, getAppLocale, getAppLocale);
