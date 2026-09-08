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

// Captured from the production registry at d8b7a2a4, before historical schemas were restored.
export const preHistoryPdfMappingRepairDeployment: WorkflowDefinitionDeployment = {
  current: {
    definitionHash: '2cf9abfc2e0c45fc2597d16d6d169df1a350e03682a2f23919a554678f37b32e',
    definitionHashVersion: 1,
    workflowId: 'pdf-mapping-repair',
  },
  supportedDefinitions: [
    '2cf9abfc2e0c45fc2597d16d6d169df1a350e03682a2f23919a554678f37b32e',
    '4f0dd23914547b3eb7babb9fe0feb6df9d52eb6e05fed57a9e70d8723bcc3d2b',
    '99b77c5a6b8c4cf3dc58b9ed699c9c142007de35fa8142d96832f8e90b904863',
  ].map(definitionHash => ({
    definitionHash,
    definitionHashVersion: 1,
    workflowId: 'pdf-mapping-repair',
  })),
};
