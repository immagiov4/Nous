import { useEffect, useMemo, useState } from 'react';

const ACTIVITY_STORAGE_KEY = 'nous-learning-activity-v2';
const ACTIVE_SESSION_WINDOW_MS = 3 * 60 * 1_000;
const DAILY_STREAK_SECONDS = 5 * 60;
const STUDY_TICK_SECONDS = 15;
const STUDY_TICK_MS = STUDY_TICK_SECONDS * 1_000;

interface LearningActivityStore {
  secondsByDate: Record<string, number>;
}

const createEmptyStore = (): LearningActivityStore => ({ secondsByDate: {} });

const getLocalDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const readActivityStore = (): LearningActivityStore => {
  if (typeof window === 'undefined') {
    return createEmptyStore();
  }

  try {
    const value = window.localStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (!value) {
      return createEmptyStore();
    }
    const parsed = JSON.parse(value) as Partial<LearningActivityStore>;
    return parsed.secondsByDate && typeof parsed.secondsByDate === 'object'
      ? { secondsByDate: parsed.secondsByDate }
      : createEmptyStore();
  } catch {
    return createEmptyStore();
  }
};

const writeActivityStore = (store: LearningActivityStore) => {
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Study tracking is optional when browser storage is unavailable.
  }
};

export const calculateLearningStreak = (
  secondsByDate: Record<string, number>,
  now = new Date()
): number => {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = getLocalDateKey(cursor);
  if ((secondsByDate[todayKey] || 0) < DAILY_STREAK_SECONDS) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while ((secondsByDate[getLocalDateKey(cursor)] || 0) >= DAILY_STREAK_SECONDS) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
};

export const formatStudyTime = (seconds: number): string => {
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

export const useStudyTimeTracking = () => {
  useEffect(() => {
    let lastInteractionAt = Date.now();
    const markInteraction = () => {
      lastInteractionAt = Date.now();
    };
    const activityEvents: Array<keyof WindowEventMap> = [
      'focus',
      'keydown',
      'pointerdown',
      'scroll',
      'touchstart',
    ];
    activityEvents.forEach(eventName => {
      window.addEventListener(eventName, markInteraction, {
        capture: eventName === 'scroll',
        passive: true,
      });
    });

    const interval = window.setInterval(() => {
      const isActivelyStudying =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        Date.now() - lastInteractionAt <= ACTIVE_SESSION_WINDOW_MS;
      if (!isActivelyStudying) {
        return;
      }

      const currentStore = readActivityStore();
      const dateKey = getLocalDateKey();
      writeActivityStore({
        secondsByDate: {
          ...currentStore.secondsByDate,
          [dateKey]: (currentStore.secondsByDate[dateKey] || 0) + STUDY_TICK_SECONDS,
        },
      });
    }, STUDY_TICK_MS);

    return () => {
      window.clearInterval(interval);
      activityEvents.forEach(eventName => {
        window.removeEventListener(eventName, markInteraction, {
          capture: eventName === 'scroll',
        });
      });
    };
  }, []);
};

export const useLearningActivity = () => {
  const [store] = useState<LearningActivityStore>(readActivityStore);

  return useMemo(() => {
    const totalSeconds = Object.values(store.secondsByDate).reduce(
      (total, seconds) => total + Math.max(0, Number(seconds) || 0),
      0
    );
    return {
      streakDays: calculateLearningStreak(store.secondsByDate),
      studyTimeLabel: formatStudyTime(totalSeconds),
      totalSeconds,
    };
  }, [store.secondsByDate]);
};
