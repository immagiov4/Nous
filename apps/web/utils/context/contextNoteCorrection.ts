import {
  type ContextNoteResult,
  createContextNoteValidationError,
  readContextNoteResult,
} from '@shared/contextNote';
import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

export const readContextNoteDraft = (input: unknown): string | undefined =>
  input &&
  typeof input === 'object' &&
  'noteDraft' in input &&
  typeof input.noteDraft === 'string' &&
  input.noteDraft.trim()
    ? input.noteDraft
    : undefined;

/** Repair incomplete fields and the requested anchor, never replace existing note content. */
export const preserveContextNoteInput = (
  input: unknown,
  original: unknown,
  recovery: Extract<ContextNoteResult, { status: 'validation_error' }>['recovery']
): unknown => {
  if (!original || typeof original !== 'object') return input;
  const fields = original as Record<string, unknown>;
  const preserved: Record<string, unknown> = {};
  for (const field of ['noteDraft', 'rationale'] as const) {
    if (typeof fields[field] === 'string') preserved[field] = fields[field];
  }
  if (!('artifactIds' in original) || original.artifactIds === undefined)
    preserved.artifactIds = undefined;
  else if (
    Array.isArray(original.artifactIds) &&
    original.artifactIds.every(id => typeof id === 'string')
  )
    preserved.artifactIds = [...original.artifactIds];
  if (recovery === 'rebuild_input') {
    if ('passageId' in original && typeof original.passageId === 'string')
      preserved.passageId = original.passageId;
    else if ('selectedTextDraft' in original && typeof original.selectedTextDraft === 'string') {
      preserved.passageId = undefined;
      preserved.selectedTextDraft = original.selectedTextDraft;
    }
  }
  return { ...(input && typeof input === 'object' ? input : {}), ...preserved };
};

/** Normalize complete note calls before the SDK records, validates or displays their input. */
export class ContextNoteChatTransport<
  Message extends UIMessage,
> extends DefaultChatTransport<Message> {
  private readonly normalizeNoteInput: (input: unknown) => unknown;
  constructor({
    normalizeNoteInput,
    ...options
  }: HttpChatTransportInitOptions<Message> & {
    normalizeNoteInput: (input: unknown) => unknown;
  }) {
    super(options);
    this.normalizeNoteInput = normalizeNoteInput;
  }
  protected override processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>
  ): ReadableStream<UIMessageChunk> {
    return super.processResponseStream(stream).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          controller.enqueue(
            chunk.type === 'tool-input-available' && chunk.toolName === 'requestAddToNotes'
              ? { ...chunk, input: this.normalizeNoteInput(chunk.input) }
              : chunk
          );
        },
      })
    );
  }
}

/** Replace stale recovery guidance only in the outgoing request, retaining historical events. */
export const refreshContextNoteMessages = <Message extends UIMessage>(
  messages: Message[],
  toolCallId: string
) =>
  messages.map(message => ({
    ...message,
    parts: message.parts.map(part =>
      part.type === 'tool-requestAddToNotes' &&
      'toolCallId' in part &&
      part.toolCallId === toolCallId
        ? { ...part, output: createContextNoteValidationError('stale_context', []) }
        : part
    ),
  }));

/** Only the current completed step can request repair; learner decisions close that path. */
export const readContextNoteCorrection = (messages: readonly UIMessage[]) => {
  const latestUserIndex = messages.map(message => message.role).lastIndexOf('user');
  const response = messages.slice(latestUserIndex + 1);
  const hasFinalDecision = response
    .flatMap(message => message.parts)
    .some(part => {
      if (part.type !== 'tool-requestAddToNotes' || !('output' in part)) return false;
      const result = readContextNoteResult(part.output);
      return result && result.status !== 'validation_error';
    });
  if (hasFinalDecision) return undefined;
  const parts = response.at(-1)?.parts ?? [];
  const lastStepStart = parts.map(part => part.type).lastIndexOf('step-start');
  for (const part of parts.slice(lastStepStart + 1)) {
    if (part.type !== 'tool-requestAddToNotes' || !('output' in part)) continue;
    const result = readContextNoteResult(part.output);
    if (result?.status !== 'validation_error' || result.recovery === 'unavailable') continue;
    if (result.recovery === 'choose_passage' && !result.availablePassageIds?.length) continue;
    return { toolCallId: part.toolCallId, recovery: result.recovery, input: part.input };
  }
  return undefined;
};
