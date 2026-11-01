import { type ContextNoteResult, createContextNoteValidationError } from '@shared/contextNote';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';
import {
  preserveContextNoteInput,
  readContextNoteCorrection,
} from '../../../utils/context/contextNoteCorrection.ts';

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
  'choose_passage',
  'refresh_context',
  'rebuild_input',
] as const)('%s preserves the original content and only permits its specified anchor repair', recovery => {
  const original = {
    passageId: 'p0',
    noteDraft: 'Original draft.',
    rationale: 'Original reason.',
    artifactIds: ['original'],
  };
  const changed = {
    passageId: 'p1',
    noteDraft: 'Changed draft.',
    rationale: 'Changed reason.',
    artifactIds: ['changed'],
  };
  expect(preserveContextNoteInput(changed, original, recovery)).toEqual({
    ...original,
    passageId: recovery === 'rebuild_input' ? 'p0' : 'p1',
  });
  expect(original.artifactIds).toEqual(['original']);
});

test('rebuild fills missing or invalid fields while retaining any draft and the original attachment absence', () => {
  const corrected = {
    passageId: 'p1',
    noteDraft: 'Replacement.',
    rationale: 'A reason.',
    artifactIds: ['added'],
  };
  expect(
    preserveContextNoteInput(
      corrected,
      { noteDraft: 'Retained.', passageId: 'p0' },
      'rebuild_input'
    )
  ).toEqual({ ...corrected, passageId: 'p0', noteDraft: 'Retained.', artifactIds: undefined });
  expect(
    preserveContextNoteInput(
      corrected,
      { noteDraft: 'Retained.', artifactIds: [1] },
      'rebuild_input'
    )
  ).toEqual({ ...corrected, noteDraft: 'Retained.' });
});

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
  ).toEqual({ toolCallId: 'malformed', recovery: 'rebuild_input', input: {} });
});
