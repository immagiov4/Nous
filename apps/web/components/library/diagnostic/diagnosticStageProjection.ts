import type { DiagnosticStage as PublicStage } from '@shared/priorKnowledgeDiagnostic';
import type { DiagnosticStage, DiagnosticTopic } from './diagnosticFlow.ts';

/** Reconstructs the display tree from the durable ordered adjacency list. */
export function projectDiagnosticStage(stage: PublicStage): DiagnosticStage {
  if (stage.kind !== 'self-assessment') return stage;
  const topics = new Map<string, DiagnosticTopic & { children: DiagnosticTopic[] }>();
  for (const topic of stage.topics) {
    if (topics.has(topic.id)) throw new Error('Duplicate diagnostic topic identity.');
    topics.set(topic.id, { id: topic.id, title: topic.title, children: [] });
  }
  const roots: DiagnosticTopic[] = [];
  for (const topic of stage.topics) {
    const current = topics.get(topic.id)!;
    if (topic.parentId === null) roots.push(current);
    else {
      const parent = topics.get(topic.parentId);
      if (!parent) throw new Error('Diagnostic parent does not exist.');
      parent.children.push(current);
    }
  }
  return { ...stage, topics: roots };
}
