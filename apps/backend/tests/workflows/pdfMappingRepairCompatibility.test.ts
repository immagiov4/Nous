import { describe, expect, test } from 'vitest';

import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { classifyWorkflowDefinitionDeployment } from '../../src/workflows/workflowDefinitionReconciler.js';
import { previousPdfMappingRepairDeployment } from './pdfMappingRepairCompatibility.fixture.js';

const previousBoundary = previousPdfMappingRepairDeployment.current;

describe('previous PDF mapping deployment', () => {
  const registry = createProductionRegistry();

  test('promotes the current registry from the previous active deployment', () => {
    const deployment = registry
      .listDefinitionDeployments()
      .find(candidate => candidate.current.workflowId === previousBoundary.workflowId);
    if (!deployment) throw new Error('PDF mapping repair is not registered.');

    expect(
      classifyWorkflowDefinitionDeployment(
        {
          current: previousPdfMappingRepairDeployment,
          previous: null,
        },
        deployment
      )
    ).toBe('promote');
  });

  test.each(
    previousPdfMappingRepairDeployment.supportedDefinitions
  )('resolves previous durable definition $definitionHash for in-flight work', boundary => {
    expect(registry.resolve(boundary.workflowId, boundary.definitionHash)).toMatchObject({
      definitionHashVersion: boundary.definitionHashVersion,
    });
  });
});
