import type * as z from 'zod';

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
