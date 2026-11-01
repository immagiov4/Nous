import { type ContextNoteResult, createContextNoteValidationError } from '@shared/contextNote';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';
import { readContextNoteCorrection } from '../../../utils/context/contextNoteCorrection.ts';

const user: UIMessage = {
  id: 'learner',
  role: 'user',
  parts: [{ type: 'text', text: 'Una nota.' }],
};
const note = (toolCallId: string, output: ContextNoteResult): UIMessage['parts'][number] => ({
  type: 'tool-requestAddToNotes',
  toolCallId,
  input: {},
  state: 'output-available',
  output,
});
const assistant = (parts: UIMessage['parts']): UIMessage => ({
  id: 'reply',
  role: 'assistant',
  parts,
});
const invalid = note('invalid', createContextNoteValidationError('unknown_passage', ['p0']));

test.each([
  { status: 'declined' },
  { status: 'cancelled' },
  { status: 'saved', mode: 'new' },
  { status: 'save_error', mode: 'update', code: 'stale_context' },
] satisfies ContextNoteResult[])('a $status decision prevents repair of another error in the same learner turn', output => {
  expect(
    readContextNoteCorrection([
      user,
      assistant([note('final', output), { type: 'step-start' }, invalid]),
    ])
  ).toBeUndefined();
  expect(
    readContextNoteCorrection([
      user,
      assistant([note('final', output)]),
      user,
      assistant([invalid]),
    ])
  ).toMatchObject({ toolCallId: 'invalid', recovery: 'choose_passage' });
});

test('only the latest step can ask for repair; rebuild_input and nonempty passage choices are actionable', () => {
  expect(
    readContextNoteCorrection([
      user,
      assistant([invalid, { type: 'step-start' }, { type: 'text', text: 'Finito.' }]),
    ])
  ).toBeUndefined();
  expect(
    readContextNoteCorrection([
      user,
      assistant([note('empty', createContextNoteValidationError('unknown_passage', []))]),
    ])
  ).toBeUndefined();
  expect(
    readContextNoteCorrection([
      user,
      assistant([note('malformed', createContextNoteValidationError('invalid_input'))]),
    ])
  ).toEqual({ toolCallId: 'malformed', recovery: 'rebuild_input' });
});
