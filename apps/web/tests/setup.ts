import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

const TEST_ENVIRONMENT = {
  AUTH_MODE: 'local-bypass',
  PROJECT_STORAGE_DRIVER: 'sqlite',
} as const;

const applyTestEnvironment = (): void => {
  Object.assign(process.env, TEST_ENVIRONMENT);
};

// Dotenv must not let a developer's local Supabase profile change the test contract.
applyTestEnvironment();

beforeEach(() => {
  applyTestEnvironment();
  vi.restoreAllMocks();
  if (typeof window !== 'undefined') {
    window.scrollTo = vi.fn();
    Object.defineProperties(window.navigator, {
      language: { configurable: true, value: 'it-IT' },
      languages: { configurable: true, value: ['it-IT'] },
    });

    const storedValues = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => {
          storedValues.clear();
        },
        getItem: (key: string) => storedValues.get(key) ?? null,
        key: (index: number) => Array.from(storedValues.keys())[index] ?? null,
        removeItem: (key: string) => {
          storedValues.delete(key);
        },
        setItem: (key: string, value: string) => {
          storedValues.set(key, value);
        },
        get length() {
          return storedValues.size;
        },
      } satisfies Storage,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
