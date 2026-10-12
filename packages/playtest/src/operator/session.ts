import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, devices, type JSHandle } from 'playwright';
import type { ObservedEvent } from '../adapter';
import { recordDiagnostic } from '../diagnostics';
import { collectSignals, drainConsoleSignals, installProbes } from '../probes/collect';
import type { ProbeSignal, ProbeWindow } from '../probes/pageProbes';
import type { Viewport } from '../types';
import { type ActionResult, executeAction, type LearnerAction } from './actions';
import {
  initializeCaptureCounter,
  type Observation,
  type OperatorWindow,
  observePage,
  redact,
} from './observe';
import { VIEWPORTS } from './viewports';

export type { ActionResult, LearnerAction } from './actions';
export type { Observation } from './observe';

const SCREENSHOT_CAPTURE_RETRIES = 1;

function waitForPaint(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

function captureVersion(): number {
  const capture = (globalThis as OperatorWindow).__playtestCapture;
  if (!capture) throw new Error('Capture counter must be installed before observation.');
  capture.version += capture.count(capture.observer.takeRecords());
  return capture.version;
}

function isGeometrySignal(signal: ProbeSignal): boolean {
  return ['clipped-text', 'overlap', 'contrast', 'horizontal-overflow'].includes(signal.kind);
}

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
  locale: string;
  credentials: { email: string; password: string };
  runDir: string;
  onEvent?: (event: ObservedEvent) => void;
}): Promise<OperatorSession> {
  const { browser, baseUrl, viewport, credentials, runDir } = options;
  await mkdir(runDir, { recursive: true });
  const context = await browser.newContext({
    ...(viewport === 'mobile'
      ? { isMobile: true, hasTouch: true, userAgent: devices['Pixel 7'].userAgent }
      : {}),
    viewport: VIEWPORTS[viewport],
    locale: options.locale,
    extraHTTPHeaders: { 'Accept-Language': options.locale },
  });
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
    await page.addInitScript(initializeCaptureCounter);
    await installProbes(page);
    await page.goto(baseUrl);
    let lastObservation: Observation | undefined;
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
        let capturedDocument: JSHandle<Document> | undefined;
        try {
          await page.waitForLoadState('load');
          // Let dispatched input paint; a navigation here invalidates capture, not the action.
          await page.evaluate(waitForPaint);
          const version = documentVersion;
          capturedDocument = await page.evaluateHandle(() => document);
          const before = await capturedDocument.evaluate(captureVersion);
          const observation = await observePage({
            page,
            stepIndex: currentStep,
            screenshotPath: join(runDir, `step-${currentStep}.png`),
            secrets: [credentials.email, credentials.password],
          });
          if (version !== documentVersion) throw new Error('Document changed during capture.');
          const signals = await collectSignals(page, capturedDocument);
          const unstable = before !== (await capturedDocument.evaluate(captureVersion));
          if (unstable && captureRetries < SCREENSHOT_CAPTURE_RETRIES) {
            capturedSignals = [
              ...(capturedSignals ?? []),
              ...signals.filter(signal => !isGeometrySignal(signal)),
            ];
            await capturedDocument.evaluate(() =>
              (globalThis as ProbeWindow).__playtestProbes?.resetGeometry()
            );
            captureRetries++;
            continue;
          }
          if (unstable) observation.diagnostics = { capture: { unstable: true } };
          capturedSignals = [...(capturedSignals ?? []), ...signals];
          lastObservation = observation;
          return observation;
        } catch (error) {
          recordDiagnostic('capture', error);
          if (captureRetries === SCREENSHOT_CAPTURE_RETRIES) throw error;
          captureRetries++;
        } finally {
          await capturedDocument?.dispose();
        }
      }
    };
    return {
      observe,
      async act(action) {
        const execution = await executeAction(page, action, credentials, {
          nodes: lastObservation?.nodes ?? [],
          mobile: viewport === 'mobile',
        });
        // Coordinate and keyboard input can navigate without Playwright's locator auto-wait.
        await page.waitForLoadState('load');
        const observation = await observe();
        if (execution.status === 'ok') return { status: execution.status, observation };
        if (execution.status === 'target-moved') return { ...execution, observation };
        const status = execution.status;
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
        // Probe text (e.g. a truncated account label) can contain the generated credentials.
        const secrets = [credentials.email, credentials.password];
        const redactSignal = (signal: ProbeSignal): ProbeSignal =>
          JSON.parse(JSON.stringify(signal), (_key, value) =>
            typeof value === 'string' ? redact(value, secrets) : value
          );
        if (capturedSignals === undefined) return (await collectSignals(page)).map(redactSignal);
        const signals = capturedSignals;
        capturedSignals = undefined;
        return [...signals, ...drainConsoleSignals(page)].map(redactSignal);
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
    recordDiagnostic('operator-open', error);
    try {
      await context.close();
    } catch (cause) {
      recordDiagnostic('operator-open-cleanup', cause);
    }
    throw error;
  }
}
