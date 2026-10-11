import type { ProbeThresholds } from './probes/thresholds';
import type { Story, Viewport } from './types';

export type ObservedEvent =
  | { kind: 'response'; url: string; status: number; headers: Record<string, string> }
  | { kind: 'console'; level: string; text: string };
export type StopVerdict = { stop: true; reason: string; correlationId?: string } | { stop: false };

/** Application setup and error policy stay outside the generic harness. */
export type PlaytestAdapter = {
  appDescription(): string;
  baseUrl(): string;
  ensureStack(): Promise<void>;
  prepare(
    story: Story,
    viewport: Viewport
  ): Promise<{ credentials: { email: string; password: string } }>;
  classify(event: ObservedEvent): StopVerdict;
  styleReference(): string[];
  taxonomy(): string;
  thresholds(): ProbeThresholds;
};
