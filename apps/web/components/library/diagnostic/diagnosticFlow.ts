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
export interface DiagnosticState {
  readonly stage: DiagnosticStage;
  readonly answers: Readonly<Record<string, DiagnosticAnswer>>;
  readonly position: number;
  readonly status: 'editing' | 'submitting' | 'failed';
}
export type DiagnosticAction =
  | { type: 'answer'; itemId: string; answer: DiagnosticAnswer }
  | { type: 'navigate'; position: number }
  | { type: 'submit' }
  | { type: 'failed' }
  | { type: 'accepted'; stage: DiagnosticStage };

export function flattenTopics(topics: readonly DiagnosticTopic[]): DiagnosticTopic[] {
  return topics.flatMap(topic => [topic, ...flattenTopics(topic.children)]);
}
export function diagnosticItems(stage: DiagnosticStage) {
  if (stage.kind === 'complete') return [];
  return stage.kind === 'round' ? stage.questions : flattenTopics(stage.topics);
}
export function initialDiagnosticState(stage: DiagnosticStage): DiagnosticState {
  return { stage, answers: {}, position: 0, status: 'editing' };
}
export function diagnosticReducer(
  state: DiagnosticState,
  action: DiagnosticAction
): DiagnosticState {
  if (action.type === 'accepted') return initialDiagnosticState(action.stage);
  if (action.type === 'failed') return { ...state, status: 'failed' };
  if (state.status === 'submitting' || state.stage.kind === 'complete') return state;
  switch (action.type) {
    case 'answer': {
      if (state.status === 'failed') return state;
      if (!diagnosticItems(state.stage).some(item => item.id === action.itemId)) return state;
      if (JSON.stringify(state.answers[action.itemId]) === JSON.stringify(action.answer))
        return state;
      return {
        ...state,
        status: 'editing',
        answers: { ...state.answers, [action.itemId]: action.answer },
      };
    }
    case 'navigate':
      if (action.position < 0 || action.position >= diagnosticItems(state.stage).length)
        return state;
      return { ...state, position: action.position };
    case 'submit':
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
