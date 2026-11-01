import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { DiagnosticAnswer, DiagnosticTopic, SelfAssessment } from './diagnosticFlow.ts';
import SelfAssessmentControl from './SelfAssessmentControl.tsx';
import { useDiagnosticSelectionAnchor } from './useDiagnosticSelectionAnchor.ts';

interface Props {
  readonly topics: readonly DiagnosticTopic[];
  readonly answers: Readonly<Record<string, DiagnosticAnswer>>;
  readonly collapsedTopics: Readonly<Record<string, boolean>>;
  readonly onToggle: (id: string) => void;
  readonly onAnswer: (id: string, value: SelfAssessment) => void;
}
interface Selection {
  readonly activeId: string | null;
  readonly activate: (id: string, control: HTMLElement) => void;
}
export default function DiagnosticTree(props: Props) {
  const selection = useDiagnosticSelectionAnchor();
  return <TopicList {...props} {...selection} />;
}
function TopicList({ topics, ...props }: Props & Selection) {
  return (
    <ul className="diagnostic-tree">
      {topics.map(topic => (
        <Topic key={topic.id} topic={topic} {...props} />
      ))}
    </ul>
  );
}
function isBranchAnswered(topic: DiagnosticTopic, answers: Props['answers']): boolean {
  return (
    answers[topic.id]?.kind === 'self-report' &&
    topic.children.every(child => isBranchAnswered(child, answers))
  );
}
function BranchContents({
  open,
  children,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="diagnostic-disclosure" data-open={open}>
      <div className="diagnostic-disclosure-clip" aria-hidden={!open} inert={!open || undefined}>
        {children}
      </div>
    </div>
  );
}
function Topic({
  topic,
  answers,
  onAnswer,
  collapsedTopics,
  onToggle,
  activeId,
  activate,
}: Omit<Props, 'topics'> & Selection & { readonly topic: DiagnosticTopic }) {
  const complete = isBranchAnswered(topic, answers);
  const open = !collapsedTopics[topic.id];
  const answer = answers[topic.id];
  const value = answer?.kind === 'self-report' ? answer.value : undefined;
  const answerStatus = value ? t('Risposta presente') : t('Nessuna risposta');
  const expandable = topic.children.length > 0 && Boolean(value);
  return (
    <li>
      <button
        type="button"
        className="diagnostic-topic"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          if (expandable) onToggle(topic.id);
        }}
      >
        <ChevronRight
          size={18}
          aria-hidden="true"
          className={`diagnostic-chevron${topic.children.length > 0 ? '' : ' invisible'}`}
        />
        <span
          aria-hidden="true"
          className="diagnostic-dot"
          data-selected={!!value}
          data-complete={complete}
        >
          {complete && <Check size={12} strokeWidth={3} />}
        </span>
        <span className="min-w-0 break-words font-semibold">{topic.title}</span>
        <span className="sr-only"> {complete ? t('Completato') : answerStatus}</span>
      </button>
      <div className="diagnostic-topic-content">
        <SelfAssessmentControl
          title={topic.title}
          value={value}
          active={activeId === topic.id}
          onActivate={control => activate(topic.id, control)}
          onChange={next => onAnswer(topic.id, next)}
        />
        {topic.children.length > 0 && (
          <BranchContents open={expandable && open}>
            <TopicList
              topics={topic.children}
              answers={answers}
              collapsedTopics={collapsedTopics}
              onToggle={onToggle}
              onAnswer={onAnswer}
              activeId={activeId}
              activate={activate}
            />
          </BranchContents>
        )}
      </div>
    </li>
  );
}
