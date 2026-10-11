import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { collectSignals, installProbes } from '../probes/collect';
import type { ProbeSignal } from '../probes/pageProbes';
import type { Viewport } from '../types';
import { type ActionResult, executeAction, type LearnerAction } from './actions';
import { type Observation, observePage } from './observe';
import { VIEWPORTS } from './viewports';

export type { ActionResult, LearnerAction } from './actions';
export type { Observation, VisibleNode } from './observe';

export type OperatorSession = {
  observe(): Promise<Observation>;
  act(action: LearnerAction): Promise<ActionResult>;
  signals(): Promise<ProbeSignal[]>;
  close(): Promise<{ tracePath: string }>;
};

/** Each story owns an isolated context; the caller retains ownership of the browser. */
export async function openOperatorSession(options: {
  browser: Browser;
  baseUrl: string;
  viewport: Viewport;
  credentials: { email: string; password: string };
  runDir: string;
}): Promise<OperatorSession> {
  const { browser, baseUrl, viewport, credentials, runDir } = options;
  await mkdir(runDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport] });
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await installProbes(page);
    await page.goto(baseUrl);
    let stepIndex = 0;
    const observe = () => {
      const currentStep = stepIndex++;
      return observePage({
        page,
        stepIndex: currentStep,
        screenshotPath: join(runDir, `step-${currentStep}.png`),
        secrets: [credentials.email, credentials.password],
      });
    };
    return {
      observe,
      async act(action) {
        const status = await executeAction(page, action, credentials);
        const observation = await observe();
        if (status === 'ok') return { status, observation };
        return {
          status,
          observation,
          detail:
            status === 'stale-reference'
              ? 'The observed element is no longer present.'
              : 'The observed element cannot receive this action.',
        };
      },
      signals: () => collectSignals(page),
      async close() {
        const tracePath = join(runDir, 'trace.zip');
        try {
          await context.tracing.stop({ path: tracePath });
          return { tracePath };
        } finally {
          await context.close();
        }
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
