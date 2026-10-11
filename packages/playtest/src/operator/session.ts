import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, JSHandle } from 'playwright';
import type { ObservedEvent } from '../adapter';
import { collectSignals, drainConsoleSignals, installProbes } from '../probes/collect';
import type { ProbeSignal } from '../probes/pageProbes';
import type { Viewport } from '../types';
import { type ActionResult, executeAction, type LearnerAction } from './actions';
import { type Observation, observePage } from './observe';
import { VIEWPORTS } from './viewports';

export type { ActionResult, LearnerAction } from './actions';
export type { Observation, VisibleNode } from './observe';

export const SCREENSHOT_CAPTURE_RETRIES = 1;

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
  onEvent?: (event: ObservedEvent) => void;
}): Promise<OperatorSession> {
  const { browser, baseUrl, viewport, credentials, runDir } = options;
  await mkdir(runDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport] });
  try {
    context.on('response', response => {
      options.onEvent?.({
        kind: 'response',
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
      });
    });
    context.on('console', message => {
      options.onEvent?.({ kind: 'console', level: message.type(), text: message.text() });
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await installProbes(page);
    await page.goto(baseUrl);
    let stepIndex = 0;
    let documentVersion = 0;
    let capturedSignals: ProbeSignal[] | undefined;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) documentVersion++;
    });
    const observe = async () => {
      const currentStep = stepIndex++;
      let captureRetries = 0;
      // Navigation invalidates the whole capture: never pair new-document probes with an old image.
      for (;;) {
        const version = documentVersion;
        let capturedDocument: JSHandle<Document> | undefined;
        try {
          capturedDocument = await page.evaluateHandle(() => document);
          const observation = await observePage({
            page,
            stepIndex: currentStep,
            screenshotPath: join(runDir, `step-${currentStep}.png`),
            secrets: [credentials.email, credentials.password],
          });
          if (version !== documentVersion) continue;
          const signals = await collectSignals(page, capturedDocument);
          capturedSignals = [...(capturedSignals ?? []), ...signals];
          return observation;
        } catch (error) {
          if (captureRetries === SCREENSHOT_CAPTURE_RETRIES) throw error;
          captureRetries++;
          if (error instanceof Error && error.message.includes('Execution context was destroyed'))
            await page.waitForLoadState('domcontentloaded');
        } finally {
          await capturedDocument?.dispose();
        }
      }
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
      async signals() {
        if (capturedSignals === undefined) return collectSignals(page);
        const signals = capturedSignals;
        capturedSignals = undefined;
        return [...signals, ...drainConsoleSignals(page)];
      },
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
