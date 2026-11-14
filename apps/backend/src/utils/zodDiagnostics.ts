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
    let candidates: z.ZodType[] = [schema];
    const path = issue.path.slice(0, MAX_DIAGNOSTIC_PATH_SEGMENTS).map(segment => {
      candidates = candidates.flatMap(diagnosticSchemaBranches);
      if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
        candidates = candidates.flatMap(candidate =>
          candidate instanceof z.ZodArray ? [candidate.element as z.ZodType] : []
        );
        return segment;
      }
      const declared =
        typeof segment === 'string' &&
        segment.length <= MAX_DIAGNOSTIC_KEY_LENGTH &&
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment)
          ? candidates.flatMap(candidate =>
              candidate instanceof z.ZodObject && Object.hasOwn(candidate.shape, segment)
                ? [candidate.shape[segment] as z.ZodType]
                : []
            )
          : [];
      candidates = declared;
      return declared.length ? (segment as string) : '*';
    });
    return { code: issue.code, path };
  } catch {
    return undefined;
  }
};

const diagnosticSchemaBranches = (schema: z.ZodType): z.ZodType[] => {
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap(option => diagnosticSchemaBranches(option as z.ZodType));
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  ) {
    return diagnosticSchemaBranches(schema.unwrap() as z.ZodType);
  }
  return [schema];
};
