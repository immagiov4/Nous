// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  calculateLearningStreak,
  formatStudyTime,
  useLearningActivity,
  useStudyTimeTracking,
} from '../../../hooks/library/useLearningActivity.ts';

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('learning activity summaries', () => {
  test('counts consecutive qualified study days', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0);

    expect(
      calculateLearningStreak(
        {
          '2026-07-13': 600,
          '2026-07-14': 300,
          '2026-07-15': 450,
        },
        now
      )
    ).toBe(3);
  });

  test('keeps yesterday streak visible until today reaches the threshold', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0);

    expect(
      calculateLearningStreak(
        {
          '2026-07-13': 300,
          '2026-07-14': 300,
          '2026-07-15': 120,
        },
        now
      )
    ).toBe(2);
  });

  test('formats accumulated study time without noisy zero units', () => {
    expect(formatStudyTime(59)).toBe('0 min');
    expect(formatStudyTime(60 * 84)).toBe('1h 24m');
    expect(formatStudyTime(60 * 120)).toBe('2h');
  });

  test('does not count time while only reading the activity summary', () => {
    renderHook(() => useLearningActivity());

    act(() => vi.advanceTimersByTime(60_000));

    expect(renderHook(() => useLearningActivity()).result.current.totalSeconds).toBe(0);
  });

  test('pauses reader study time after three idle minutes and resumes on activity', () => {
    renderHook(() => useStudyTimeTracking());
    const readingArea = document.createElement('div');
    document.body.append(readingArea);

    act(() => vi.advanceTimersByTime(4 * 60_000));
    expect(renderHook(() => useLearningActivity()).result.current.totalSeconds).toBe(180);

    act(() => {
      readingArea.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(15_000);
    });
    expect(renderHook(() => useLearningActivity()).result.current.totalSeconds).toBe(195);
    readingArea.remove();
  });
});
