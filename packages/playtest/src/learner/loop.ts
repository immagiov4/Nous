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
type LearnerObservation = Omit<Observation, 'url'>;
export type LearnerInput = {
  systemPrompt: string;
  history: LearnerTurn<LearnerObservation>[];
  observation: LearnerObservation;
};
export type LearnerTurn<View = Observation> = {
  decision: LearnerDecision;
  result?: ActionResult<View>;
};
export type MissionOutcome = 'completed' | 'abandoned' | 'harness-limit' | 'operator-failure';
export type LearnerRunResult = {
  outcome: MissionOutcome | 'app-error';
  reason?: string;
  turns: LearnerTurn[];
  diary: string[];
  friction: string[];
  observations: Observation[];
};

/** Page addresses belong to operator evidence, not the learner's visible context. */
function learnerObservation(observation: Observation): LearnerObservation {
  const { stepIndex, screenshotPath, nodes } = observation;
  return { stepIndex, screenshotPath, nodes };
}

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
        history: result.turns.map(turn => ({
          decision: turn.decision,
          ...(turn.result
            ? {
                result: {
                  ...turn.result,
                  observation: learnerObservation(turn.result.observation),
                },
              }
            : {}),
        })),
        observation: learnerObservation(observation),
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
