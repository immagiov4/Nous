import type { DecisionSource, LearnerDecision, LearnerInput } from './loop';

/** Callbacks allow a deterministic script to use refs from the latest observation. */
export function createScriptedDecisionSource(
  decisions: readonly (LearnerDecision | ((input: LearnerInput) => LearnerDecision))[]
): DecisionSource {
  let index = 0;
  return {
    async decide(input) {
      if (index >= decisions.length) throw new Error('Scripted decision source exhausted.');
      const decision = decisions[index++];
      return typeof decision === 'function' ? decision(input) : decision;
    },
  };
}
