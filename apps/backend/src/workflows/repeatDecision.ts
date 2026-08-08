import type { ZodType } from 'zod';
import * as z from 'zod';

import type { RepeatDecision } from './types.js';

export const repeatDecisionSchema = <StateSchema extends ZodType>(stateSchema: StateSchema) =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('continue'), state: stateSchema }),
    z.object({ kind: z.literal('finish'), state: stateSchema }),
  ]);

export const continueRepeatWith = <State>(state: State): RepeatDecision<State> => ({
  kind: 'continue',
  state,
});

export const finishRepeat = <State>(state: State): RepeatDecision<State> => ({
  kind: 'finish',
  state,
});
