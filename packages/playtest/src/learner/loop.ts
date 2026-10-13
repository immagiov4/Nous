import { recordDiagnostic } from '../diagnostics';
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

function learnerHistory(turns: LearnerTurn[]): LearnerInput['history'] {
  return turns.map(turn => ({
    decision: turn.decision,
    ...(turn.result
      ? { result: { ...turn.result, observation: learnerObservation(turn.result.observation) } }
      : {}),
  }));
}

/** Records one decision and its observable effects; failures retain the already recorded turn. */
async function recordTurn(
  result: LearnerRunResult,
  decision: LearnerDecision,
  operator: OperatorSession
): Promise<boolean> {
  const turn: LearnerTurn = { decision };
  result.turns.push(turn);
  switch (decision.type) {
    case 'act':
      turn.result = await operator.act(decision.action);
      result.observations.push(turn.result.observation);
      break;
    case 'diary':
      result.diary.push(decision.entry);
      break;
    case 'report-friction':
      result.friction.push(decision.text);
      break;
    case 'stop':
      result.outcome = decision.reason;
      return true;
  }
  return false;
}

function learnerFailure(input: {
  result: LearnerRunResult;
  stage: string;
  error: unknown;
  shouldStop: () => string | undefined;
  reason?: string;
}): LearnerRunResult {
  recordDiagnostic(input.stage, input.error, {
    operational: input.shouldStop() === undefined,
  });
  input.result.outcome = input.shouldStop() === undefined ? 'operator-failure' : 'app-error';
  if (input.reason) input.result.reason = input.reason;
  return input.result;
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
  } catch (error) {
    return learnerFailure({ result, stage: 'observation', error, shouldStop: input.shouldStop });
  }
  const systemPrompt = buildLearnerPrompt(input);
  while (result.turns.length < input.story.budget.steps) {
    if (appStopped()) return result;
    let decision: LearnerDecision;
    try {
      decision = await input.source.decide({
        systemPrompt,
        history: learnerHistory(result.turns),
        observation: learnerObservation(observation),
      });
    } catch (error) {
      return learnerFailure({
        result,
        stage: 'decision',
        error,
        shouldStop: input.shouldStop,
        reason: 'The learner could not obtain its next decision.',
      });
    }
    if (appStopped()) return result;
    try {
      if (await recordTurn(result, decision, input.operator)) return result;
      observation = result.turns.at(-1)?.result?.observation ?? observation;
    } catch (error) {
      return learnerFailure({ result, stage: 'action', error, shouldStop: input.shouldStop });
    }
    if (appStopped()) return result;
  }
  return result;
}
