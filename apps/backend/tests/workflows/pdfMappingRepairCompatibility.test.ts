import { describe, expect, test } from 'vitest';

import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { classifyWorkflowDefinitionDeployment } from '../../src/workflows/workflowDefinitionReconciler.js';
import {
  preHistoryPdfMappingRepairDeployment,
  previousPdfMappingRepairDeployment,
} from './pdfMappingRepairCompatibility.fixture.js';

const previousBoundary = previousPdfMappingRepairDeployment.current;

describe('previous PDF mapping deployment', () => {
  const registry = createProductionRegistry();
  const deployment = registry
    .listDefinitionDeployments()
    .find(candidate => candidate.current.workflowId === previousBoundary.workflowId);
  if (!deployment) throw new Error('PDF mapping repair is not registered.');

  test.each([
    previousPdfMappingRepairDeployment,
    preHistoryPdfMappingRepairDeployment,
  ])('promotes from preceding deployment $current.definitionHash', previous => {
    expect(
      classifyWorkflowDefinitionDeployment(
        {
          current: previous,
          previous: null,
        },
        deployment
      )
    ).toBe('promote');
  });

  test('keeps a restarting parent replica stale after the historical upgrade', () => {
    expect(
      classifyWorkflowDefinitionDeployment(
        {
          current: deployment,
          previous: previousPdfMappingRepairDeployment,
        },
        preHistoryPdfMappingRepairDeployment
      )
    ).toBe('stale');
  });

  test('keeps an identical replica authoritative without changing its deployment', () => {
    expect(
      classifyWorkflowDefinitionDeployment(
        {
          current: deployment,
          previous: previousPdfMappingRepairDeployment,
        },
        deployment
      )
    ).toBe('unchanged');
  });

  test.each([
    ...previousPdfMappingRepairDeployment.supportedDefinitions,
    ...preHistoryPdfMappingRepairDeployment.supportedDefinitions,
  ])('resolves previous durable definition $definitionHash for in-flight work', boundary => {
    expect(registry.resolve(boundary.workflowId, boundary.definitionHash)).toMatchObject({
      definitionHashVersion: boundary.definitionHashVersion,
    });
  });
});
