interface EntityIdOptions {
  fallbackPrefix: string;
  uuidPrefix?: string;
}

export const createEntityId = ({ fallbackPrefix, uuidPrefix }: EntityIdOptions): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    const id = crypto.randomUUID();
    return uuidPrefix ? `${uuidPrefix}-${id}` : id;
  }

  return `${fallbackPrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};
