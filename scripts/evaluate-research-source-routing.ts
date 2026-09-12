import assert from 'node:assert/strict';
import { getGlobalModelConfig } from '../apps/backend/src/config/modelConfig.js';
import {
  isResearchSourceSelected,
  planResearchSources,
} from '../apps/backend/src/services/researchSourceRouting.js';
import { researchRoutingScenarios } from '../apps/backend/tests/services/researchSourceRouting.scenarios.js';

// Explicit opt-in: these evaluations call the configured production adapter with Luna.
assert(process.argv.includes('--live'), 'Pass --live to run the model evaluation.');
const config = {
  ...getGlobalModelConfig(),
  aiProvider: 'codex' as const,
  aiProviderOverrides: {},
  codexContextModel: 'gpt-5.6-luna',
};
for (const repetition of [1, 2]) {
  for (const scenario of researchRoutingScenarios) {
    const started = Date.now();
    const decision = await planResearchSources({
      ...scenario,
      config,
      availableChannels: ['web', 'youtube'],
      signal: new AbortController().signal,
    });
    const mismatches = [
      ...(decision.suppliedSourcesSufficient === scenario.suppliedSourcesSufficient
        ? []
        : ['suppliedSourcesSufficient']),
      ...scenario.selected.filter(type => !isResearchSourceSelected(decision, type)),
      ...scenario.skipped.filter(type => isResearchSourceSelected(decision, type)),
    ];
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        repetition,
        model: config.codexContextModel,
        elapsedMs: Date.now() - started,
        decision,
        mismatches,
      })
    );
    if (mismatches.length) process.exitCode = 1;
  }
}
