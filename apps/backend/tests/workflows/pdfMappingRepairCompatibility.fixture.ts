import type { WorkflowDefinitionDeployment } from '../../src/workflows/types.js';

// Captured by evaluating createProductionRegistry().listDefinitionDeployments() at 2f44b0f9.
export const previousPdfMappingRepairDeployment: WorkflowDefinitionDeployment = {
  current: {
    definitionHash: '493daee07712cb9408d40f3930de82cf079e3b06d114d22d366aad9df91cf11c',
    definitionHashVersion: 1,
    workflowId: 'pdf-mapping-repair',
  },
  supportedDefinitions: [
    '19d6f26fcd1091de35adb8fef206304d9e34ff69809a58bfdc5841c103455709',
    '493daee07712cb9408d40f3930de82cf079e3b06d114d22d366aad9df91cf11c',
    'c61e6a6ffc8f5aa685b27fdbcd4b518c4ea5f99b319441c4fac837b8c25f213e',
  ].map(definitionHash => ({
    definitionHash,
    definitionHashVersion: 1,
    workflowId: 'pdf-mapping-repair',
  })),
};
