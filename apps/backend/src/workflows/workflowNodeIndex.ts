import type { WorkflowDefinition, WorkflowNode } from './types.js';

export const escapeWorkflowPathSegment = (value: string): string =>
  value.replaceAll('~', '~0').replaceAll('/', '~1');

export const workflowChildPath = (parent: string | undefined, segment: string): string =>
  parent ? `${parent}/${escapeWorkflowPathSegment(segment)}` : escapeWorkflowPathSegment(segment);

const asWorkflowNode = (value: unknown): WorkflowNode => value as WorkflowNode;

type WorkflowCatalog = Pick<WorkflowDefinition, 'events' | 'signals'>;

export interface IndexedWorkflowNode {
  readonly definitionId: string;
  readonly events: WorkflowCatalog['events'];
  readonly namespace: string | undefined;
  readonly node: WorkflowNode;
  readonly signals: WorkflowCatalog['signals'];
}

export const indexWorkflowNodes = <Input, Output, Config, Services>(
  definition: Pick<
    WorkflowDefinition<Input, Output, Config, Services>,
    'events' | 'root' | 'signals'
  >
): ReadonlyMap<string, IndexedWorkflowNode> => {
  const indexed = new Map<string, IndexedWorkflowNode>();
  const visit = (
    node: WorkflowNode,
    namespace: string | undefined,
    catalog: WorkflowCatalog
  ): void => {
    const definitionId = workflowChildPath(namespace, node.id);
    if (indexed.has(definitionId)) {
      throw new Error(`Duplicate workflow node definition ${definitionId}.`);
    }
    indexed.set(definitionId, {
      definitionId,
      events: catalog.events,
      namespace,
      node,
      signals: catalog.signals,
    });
    switch (node.kind) {
      case 'workflow':
        visit(asWorkflowNode(node.root), definitionId, node);
        return;
      case 'sequence':
        for (const child of node.nodes) visit(asWorkflowNode(child), namespace, catalog);
        return;
      case 'routeBy':
        for (const child of Object.values(node.cases)) {
          visit(asWorkflowNode(child), namespace, catalog);
        }
        return;
      case 'fanOut':
        visit(asWorkflowNode(node.worker), namespace, catalog);
        return;
      case 'repeat':
        visit(asWorkflowNode(node.body), namespace, catalog);
        return;
      case 'emit':
      case 'step':
      case 'waitForSignal':
        return;
    }
  };
  visit(definition.root as WorkflowNode, undefined, definition);
  return indexed;
};
