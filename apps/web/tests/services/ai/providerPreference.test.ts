/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';

import {
  addAiProviderPreferenceHeader,
  getAiProviderPreference,
  setAiProviderPreference,
} from '../../../services/ai/providerPreference.ts';

describe('AI provider preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('round-trips an allowlisted provider into authenticated AI request headers', () => {
    setAiProviderPreference('codex');

    const headers = new Headers(addAiProviderPreferenceHeader({ 'X-Existing-Header': 'kept' }));

    expect(getAiProviderPreference()).toBe('codex');
    expect(headers.get('X-Existing-Header')).toBe('kept');
    expect(headers.get('X-Nous-AI-Provider')).toBe('codex');

    setAiProviderPreference(null);
    expect(getAiProviderPreference()).toBeNull();
  });
});
