// Creates stable entity identifiers for backend records.
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

export const createEntityId = (fallbackPrefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${fallbackPrefix}-${getFallbackEntityIdEntropy()}`;
};
