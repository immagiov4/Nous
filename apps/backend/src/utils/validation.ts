// Shared runtime validation helpers for backend input.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const readOptionalString = (value: unknown): string | undefined => {
  const text = readString(value)?.trim();
  return text || undefined;
};

export const readNullableString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }

  return readOptionalString(value);
};

export const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
