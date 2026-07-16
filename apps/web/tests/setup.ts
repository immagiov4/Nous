import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
}

const TEST_ENVIRONMENT = {
  AUTH_MODE: 'local-bypass',
  SUPABASE_SERVICE_ROLE_KEY: '',
  SUPABASE_URL: '',
} as const;

const applyTestEnvironment = (): void => {
  Object.assign(process.env, TEST_ENVIRONMENT);
};

const shouldApplyTestEnvironment = process.env.RUN_SUPABASE_LOCAL_TESTS !== '1';

// Dotenv must not let a developer's local Supabase profile change the default test contract.
if (shouldApplyTestEnvironment) applyTestEnvironment();

beforeEach(() => {
  if (shouldApplyTestEnvironment) applyTestEnvironment();
  vi.restoreAllMocks();
  if (typeof window !== 'undefined') {
    window.scrollTo = vi.fn();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
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
