import * as z from 'zod';

export interface SanitizedZodIssue {
  readonly code: string;
  readonly path: readonly (number | string)[];
}

const sanitizePathSegment = (segment: PropertyKey): number | string =>
  typeof segment === 'number' || typeof segment === 'string' ? segment : '*';

/** Keeps one actionable issue while excluding messages, received values, and source content. */
export const firstSanitizedZodIssue = (error: z.ZodError): SanitizedZodIssue => {
  const issue = error.issues[0];
  if (!issue) throw new Error('Zod validation failed without an issue.');
  return {
    code: issue.code,
    path: issue.path.map(sanitizePathSegment),
  };
};

export const formatValidationPath = (path: readonly (number | string)[]): string => {
  const formattedPath = path.reduce<string>((formatted, segment) => {
    if (typeof segment === 'number') return `${formatted}[${segment}]`;
    if (formatted) return `${formatted}.${segment}`;
    return segment;
  }, '');
  return formattedPath || '<root>';
};

// Diagnostic budgets bound metadata independently of input size.
const MAX_DIAGNOSTIC_PATH_SEGMENTS = 32;
const MAX_DIAGNOSTIC_KEY_LENGTH = 128;

/** Exposes only declared object keys; record keys and unsupported schema branches stay opaque. */
export const schemaSanitizedZodIssue = (
  error: z.ZodError,
  schema: z.ZodType
): SanitizedZodIssue | undefined => {
  try {
    const issue = error.issues[0];
    if (!issue) return undefined;
    let current: z.ZodType | undefined = schema;
    const path = issue.path.slice(0, MAX_DIAGNOSTIC_PATH_SEGMENTS).map(segment => {
      while (
        current instanceof z.ZodOptional ||
        current instanceof z.ZodNullable ||
        current instanceof z.ZodReadonly
      )
        current = current.unwrap() as z.ZodType;
      if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
        current = current instanceof z.ZodArray ? (current.element as z.ZodType) : undefined;
        return segment;
      }
      if (
        typeof segment === 'string' &&
        segment.length <= MAX_DIAGNOSTIC_KEY_LENGTH &&
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment) &&
        current instanceof z.ZodObject &&
        Object.hasOwn(current.shape, segment)
      ) {
        current = current.shape[segment];
        return segment;
      }
      current = undefined;
      return '*';
    });
    return { code: issue.code, path };
  } catch {
    return undefined;
  }
};
