import type {
  ActionResult,
  LearnerAction,
  Observation,
  OperatorSession,
} from '../operator/session';
import type { Persona, Story } from '../types';
import { buildLearnerPrompt } from './prompt';

export type LearnerDecision =
  | { type: 'act'; action: LearnerAction; expectation: string }
  | { type: 'report-friction'; text: string }
  | { type: 'diary'; entry: string }
  | { type: 'stop'; reason: 'completed' | 'abandoned'; summary: string };
export type DecisionSource = { decide(input: LearnerInput): Promise<LearnerDecision> };
export type LearnerInput = {
  systemPrompt: string;
  history: LearnerTurn[];
  observation: Observation;
};
export type LearnerTurn = { decision: LearnerDecision; result?: ActionResult };
export type MissionOutcome = 'completed' | 'abandoned' | 'harness-limit' | 'operator-failure';
export type LearnerRunResult = {
  outcome: MissionOutcome | 'app-error';
  reason?: string;
  turns: LearnerTurn[];
  diary: string[];
  friction: string[];
  observations: Observation[];
};

/** The caller owns operator cleanup. Each decision, including diary entries, consumes a step. */
export async function runLearner(input: {
  story: Story;
  persona?: Persona;
  appDescription: string;
  operator: OperatorSession;
  source: DecisionSource;
  shouldStop: () => string | undefined;
}): Promise<LearnerRunResult> {
  const result: LearnerRunResult = {
    outcome: 'harness-limit',
    turns: [],
    diary: [],
    friction: [],
    observations: [],
  };
  const appStopped = () => {
    if (input.shouldStop() === undefined) return false;
    result.outcome = 'app-error';
    return true;
  };
  let observation: Observation;
  try {
    observation = await input.operator.observe();
    result.observations.push(observation);
  } catch {
    result.outcome = appStopped() ? 'app-error' : 'operator-failure';
    return result;
  }
  const systemPrompt = buildLearnerPrompt(input);
  while (result.turns.length < input.story.budget.steps) {
    if (appStopped()) return result;
    let decision: LearnerDecision;
    try {
      decision = await input.source.decide({
        systemPrompt,
        history: [...result.turns],
        observation,
      });
    } catch {
      result.outcome = appStopped() ? 'app-error' : 'operator-failure';
      result.reason = 'The learner could not obtain its next decision.';
      return result;
    }
    if (appStopped()) return result;
    const turn: LearnerTurn = { decision };
    result.turns.push(turn);
    switch (decision.type) {
      case 'act':
        try {
          turn.result = await input.operator.act(decision.action);
          observation = turn.result.observation;
          result.observations.push(observation);
        } catch {
          result.outcome = appStopped() ? 'app-error' : 'operator-failure';
          return result;
        }
        break;
      case 'diary':
        result.diary.push(decision.entry);
        break;
      case 'report-friction':
        result.friction.push(decision.text);
        break;
      case 'stop':
        result.outcome = decision.reason;
        return result;
    }
    if (appStopped()) return result;
  }
  return result;
}
