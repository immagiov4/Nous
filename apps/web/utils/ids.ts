interface EntityIdOptions {
  fallbackPrefix: string;
  uuidPrefix?: string;
}

let fallbackEntityIdCounter = 0;

const getFallbackEntityIdEntropy = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);
    return Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  fallbackEntityIdCounter += 1;
  return `${Date.now().toString(16)}-${fallbackEntityIdCounter.toString(16)}`;
};

export const createEntityId = ({ fallbackPrefix, uuidPrefix }: EntityIdOptions): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    const id = crypto.randomUUID();
    return uuidPrefix ? `${uuidPrefix}-${id}` : id;
  }

  return `${fallbackPrefix}-${getFallbackEntityIdEntropy()}`;
};
