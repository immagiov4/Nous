import * as z from 'zod';

const ContextNoteModeSchema = z.enum(['new', 'update']);
const ContextNoteValidationCodeSchema = z.enum([
  'invalid_input',
  'unknown_passage',
  'stale_context',
  'no_annotatable_passage',
  'target_not_annotatable',
  'anchor_mismatch',
]);

const validationRecovery = {
  invalid_input: 'rebuild_input',
  unknown_passage: 'choose_passage',
  stale_context: 'refresh_context',
  no_annotatable_passage: 'unavailable',
  target_not_annotatable: 'choose_passage',
  anchor_mismatch: 'choose_passage',
} as const satisfies Record<z.infer<typeof ContextNoteValidationCodeSchema>, string>;

/** Tool outcomes distinguish a learner's choice from automatic validation and write failures. */
export const ContextNoteResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    mode: ContextNoteModeSchema,
    annotationId: z.string().optional(),
  }),
  z.object({ status: z.literal('declined') }),
  z
    .object({
      status: z.literal('validation_error'),
      code: ContextNoteValidationCodeSchema,
      recovery: z.enum(['choose_passage', 'rebuild_input', 'refresh_context', 'unavailable']),
      availablePassageIds: z.array(z.string()).optional(),
    })
    .refine(result => result.recovery === validationRecovery[result.code]),
  z.object({
    status: z.literal('save_error'),
    mode: ContextNoteModeSchema,
    code: z.enum(['save_failed', 'artifact_unavailable']),
  }),
  z.object({ status: z.literal('cancelled') }),
]);
export type ContextNoteResult = z.infer<typeof ContextNoteResultSchema>;

export const createContextNoteValidationError = (
  code: z.infer<typeof ContextNoteValidationCodeSchema>,
  availablePassageIds?: string[]
): Extract<ContextNoteResult, { status: 'validation_error' }> => ({
  status: 'validation_error',
  code,
  recovery: validationRecovery[code],
  ...(availablePassageIds === undefined ? {} : { availablePassageIds }),
});

const LegacyContextNoteResultSchema = z.object({
  approved: z.boolean(),
  saved: z.boolean(),
  mode: z.enum(['new', 'update', 'none']),
  annotationId: z.string().optional(),
});

/** Read old conversation parts without exposing historical free-form errors. New calls use status. */
export const readContextNoteResult = (value: unknown): ContextNoteResult | undefined => {
  const current = ContextNoteResultSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = LegacyContextNoteResultSchema.safeParse(value);
  if (!legacy.success) return undefined;
  if (!legacy.data.approved) return { status: 'declined' };
  const { mode, annotationId, saved } = legacy.data;
  if (mode === 'none') return undefined;
  return saved
    ? { status: 'saved', mode, annotationId }
    : { status: 'save_error', mode, code: 'save_failed' };
};

const ContextNoteCandidateOutcomeSchema = z.enum([
  'empty_selection',
  'no_segments',
  'text_mismatch',
  'anchorable',
]);
export type ContextNoteCandidateOutcome = z.infer<typeof ContextNoteCandidateOutcomeSchema>;
const candidateRoles = ['proposed', 'original_selection'] as const;
const candidateOutcomesSchema = z
  .array(ContextNoteCandidateOutcomeSchema)
  .max(candidateRoles.length);

const eventBase = z.object({
  operationId: z.uuid(),
  contextScope: z.enum(['selection', 'lesson', 'annotation']),
  durationMs: z.number().nonnegative(),
});

/** Strict collection allowlist: no model identifiers, lesson/note text, offsets or exception strings. */
export const ContextNoteEventSchema = z.discriminatedUnion('phase', [
  eventBase
    .extend({
      phase: z.literal('catalog'),
      outcome: z.enum(['complete', 'clipped', 'unavailable']),
      totalEntries: z.number().int().nonnegative(),
      includedEntries: z.number().int().nonnegative(),
      serializedChars: z.number().int().nonnegative(),
    })
    .strict()
    .refine(event => event.includedEntries <= event.totalEntries),
  eventBase
    .extend({
      phase: z.literal('proposal'),
      outcome: z.enum(['accepted', 'validation_error']),
      code: ContextNoteValidationCodeSchema.optional(),
      // ID proposals report one target; retain the second slot for earlier client diagnostics.
      candidateOutcomes: candidateOutcomesSchema,
    })
    .strict()
    .refine(event => (event.outcome === 'validation_error') === (event.code !== undefined)),
  eventBase
    .extend({ phase: z.literal('decision'), outcome: z.enum(['approved', 'declined']) })
    .strict(),
  eventBase
    .extend({
      phase: z.literal('save'),
      outcome: z.enum(['saved', 'save_error']),
      code: z.enum(['save_failed', 'artifact_unavailable']).optional(),
    })
    .strict()
    .refine(event => (event.outcome === 'save_error') === (event.code !== undefined)),
  eventBase.extend({ phase: z.literal('cancel'), outcome: z.literal('cancelled') }).strict(),
]);
export type ContextNoteEvent = z.infer<typeof ContextNoteEventSchema>;
export type ContextNoteEventPayload = {
  [Phase in ContextNoteEvent['phase']]: Omit<
    Extract<ContextNoteEvent, { phase: Phase }>,
    'operationId'
  >;
}[ContextNoteEvent['phase']];
