export const createEntityId = (fallbackPrefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${fallbackPrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};
