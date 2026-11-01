/** Local presentation boundary. No curriculum identities or persistence policy live here. */
export const SELF_ASSESSMENT_OPTIONS = [
  { value: 'unfamiliar', label: 'Non lo conosco', description: 'Non riconosco l’argomento.' },
  {
    value: 'heard-of',
    label: 'Ne ho sentito parlare',
    description: 'Lo riconosco, ma non saprei spiegarlo.',
  },
  {
    value: 'basics',
    label: 'Ne conosco le basi',
    description: 'Saprei spiegare gli elementi principali, ma avrei bisogno di aiuto per usarli.',
  },
  {
    value: 'independent',
    label: 'Mi sento autonomo',
    description: 'Ritengo di poter affrontare compiti pertinenti senza aiuto.',
  },
] as const;

export type SelfAssessment = (typeof SELF_ASSESSMENT_OPTIONS)[number]['value'] | 'uncertain';
export interface DiagnosticTopic {
  readonly id: string;
  readonly title: string;
  readonly children: readonly DiagnosticTopic[];
}
export type DiagnosticQuestion = {
  readonly id: string;
  readonly topic: string;
  readonly prompt: string;
} & (
  | { readonly format: 'text' }
  | { readonly format: 'choice'; readonly options: readonly { id: string; text: string }[] }
);

export type DiagnosticStage =
  | {
      readonly kind: 'self-assessment';
      readonly id: string;
      readonly title: string;
      readonly topics: readonly DiagnosticTopic[];
    }
  | {
      readonly kind: 'round';
      readonly id: string;
      readonly title: string;
      readonly questions: readonly DiagnosticQuestion[];
    }
  | {
      readonly kind: 'complete';
      readonly id: string;
      readonly title: string;
      readonly feedback: string;
    };

export type DiagnosticAnswer =
  | { readonly kind: 'self-report'; readonly value: SelfAssessment }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'choice'; readonly optionId: string };
export interface DiagnosticSubmission {
  readonly collectionId: string;
  readonly stageId: string;
  readonly requestId: string;
  readonly answers: readonly {
    readonly itemId: string;
    readonly response: DiagnosticAnswer | { readonly kind: 'not-submitted' };
  }[];
}

/** submit resolves only after acceptance; retries retain requestId. The adapter owns recovery and authorization. */
export interface DiagnosticAdapter {
  readonly onComplete?: () => Promise<void>;
  readonly collectionId: string;
  readonly initial: DiagnosticStage;
  readonly submit: (submission: DiagnosticSubmission) => Promise<DiagnosticStage>;
}
export class DiagnosticStoppedError extends Error {}
export interface DiagnosticState {
  readonly stage: DiagnosticStage;
  readonly answers: Readonly<Record<string, DiagnosticAnswer>>;
  readonly inferredFrom: Readonly<Record<string, string>>;
  readonly collapsedTopics: Readonly<Record<string, boolean>>;
  readonly position: number;
  readonly status: 'editing' | 'submitting' | 'failed' | 'stopped';
}
export type DiagnosticAction =
  | { type: 'answer'; itemId: string; answer: DiagnosticAnswer }
  | { type: 'toggle-topic'; itemId: string }
  | { type: 'navigate'; position: number }
  | { type: 'submit' }
  | { type: 'failed' }
  | { type: 'stopped' }
  | { type: 'accepted'; stage: DiagnosticStage };

export function flattenTopics(topics: readonly DiagnosticTopic[]): DiagnosticTopic[] {
  return topics.flatMap(topic => [topic, ...flattenTopics(topic.children)]);
}
export function diagnosticItems(stage: DiagnosticStage) {
  if (stage.kind === 'complete') return [];
  return stage.kind === 'round' ? stage.questions : flattenTopics(stage.topics);
}
export function initialDiagnosticState(stage: DiagnosticStage): DiagnosticState {
  return {
    stage,
    answers: {},
    inferredFrom: {},
    collapsedTopics: {},
    position: 0,
    status: 'editing',
  };
}
/** Cascade ownership lets a later parent edit clear only that parent's inferred answers. */
function answerTopic(
  state: DiagnosticState,
  topic: DiagnosticTopic,
  answer: DiagnosticAnswer
): DiagnosticState {
  if (answer.kind !== 'self-report') return state;
  const answers = { ...state.answers, [topic.id]: answer };
  const inferredFrom = { ...state.inferredFrom };
  delete inferredFrom[topic.id];
  const unfamiliar = answer.value === 'unfamiliar';
  const descendants = flattenTopics(topic.children);
  const descendantIds = new Set(descendants.map(descendant => descendant.id));
  for (const descendant of descendants) {
    const previous = answers[descendant.id];
    if (previous && !inferredFrom[descendant.id]) continue;
    // An explicitly unknown subtopic owns its own cascade, even inside this branch.
    const owner = inferredFrom[descendant.id];
    if (owner && descendantIds.has(owner) && !state.inferredFrom[owner]) continue;
    if (unfamiliar) {
      answers[descendant.id] = { kind: 'self-report', value: 'unfamiliar' };
      inferredFrom[descendant.id] = topic.id;
    } else if (owner === topic.id || (owner && owner === state.inferredFrom[topic.id])) {
      delete answers[descendant.id];
      delete inferredFrom[descendant.id];
    }
  }
  return {
    ...state,
    answers,
    inferredFrom,
    collapsedTopics:
      unfamiliar && topic.children.length > 0
        ? { ...state.collapsedTopics, [topic.id]: true }
        : state.collapsedTopics,
  };
}
function answerItem(
  state: DiagnosticState,
  action: Extract<DiagnosticAction, { type: 'answer' }>
): DiagnosticState {
  if (state.status === 'failed' || state.status === 'stopped') return state;
  if (!diagnosticItems(state.stage).some(item => item.id === action.itemId)) return state;
  if (
    !state.inferredFrom[action.itemId] &&
    !(
      state.stage.kind === 'self-assessment' &&
      action.answer.kind === 'self-report' &&
      action.answer.value === 'unfamiliar'
    ) &&
    JSON.stringify(state.answers[action.itemId]) === JSON.stringify(action.answer)
  )
    return state;
  if (state.stage.kind === 'self-assessment') {
    const topic = flattenTopics(state.stage.topics).find(item => item.id === action.itemId);
    if (!topic) return state;
    return answerTopic(state, topic, action.answer);
  }
  return {
    ...state,
    status: 'editing',
    answers: { ...state.answers, [action.itemId]: action.answer },
  };
}
export function diagnosticReducer(
  state: DiagnosticState,
  action: DiagnosticAction
): DiagnosticState {
  if (action.type === 'accepted') return initialDiagnosticState(action.stage);
  if (action.type === 'failed') return { ...state, status: 'failed' };
  if (action.type === 'stopped') return { ...state, status: 'stopped' };
  if (state.status === 'submitting' || state.stage.kind === 'complete') return state;
  switch (action.type) {
    case 'answer':
      return answerItem(state, action);
    case 'toggle-topic':
      return {
        ...state,
        collapsedTopics: {
          ...state.collapsedTopics,
          [action.itemId]: !state.collapsedTopics[action.itemId],
        },
      };
    case 'navigate':
      if (action.position < 0 || action.position >= diagnosticItems(state.stage).length)
        return state;
      return { ...state, position: action.position };
    case 'submit':
      if (state.status === 'stopped') return state;
      return { ...state, status: 'submitting' };
  }
}
export function buildDiagnosticSubmission(
  state: DiagnosticState,
  collectionId: string,
  requestId: string
): DiagnosticSubmission {
  return {
    collectionId,
    stageId: state.stage.id,
    requestId,
    answers: diagnosticItems(state.stage).map(item => {
      const response = state.answers[item.id];
      return {
        itemId: item.id,
        response:
          !response || (response.kind === 'text' && !response.text.trim())
            ? { kind: 'not-submitted' }
            : response,
      };
    }),
  };
}
