// NOTE: jest-dom matchers are extended per-file via `import '@testing-library/jest-dom/vitest';`
// because vitest setupFiles run before the environment is set up.
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof window !== 'undefined') {
    window.scrollTo = vi.fn();

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
