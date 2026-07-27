export const INTERNAL_REASONING_EFFICIENCY_INSTRUCTION =
  'Use tokens efficiently in your internal reasoning and spend them only on decisions that affect correctness. This never authorizes shortening, flattening, or omitting user-facing output.';

export const INTERNAL_FAST_TASK_INSTRUCTION = `${INTERNAL_REASONING_EFFICIENCY_INSTRUCTION} Do not overthink this non-verification task; satisfy the requested contract directly.`;
