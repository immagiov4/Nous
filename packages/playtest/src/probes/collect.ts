import type { JSHandle, Page } from 'playwright';
import { initializePageProbes, type ProbeSignal, type ProbeWindow } from './pageProbes';

const consoleSignals = new WeakMap<Page, ProbeSignal[]>();

/** Console events survive document navigation and can arrive after viewport capture. */
export function drainConsoleSignals(page: Page): ProbeSignal[] {
  return consoleSignals.get(page)?.splice(0) ?? [];
}

/** Installs before future page scripts and also covers the current document (including setContent). */
export async function installProbes(page: Page): Promise<void> {
  if (consoleSignals.has(page)) return;
  const signals: ProbeSignal[] = [];
  consoleSignals.set(page, signals);
  page.on('console', message => {
    if (message.type() === 'error')
      signals.push({ kind: 'console-error', message: message.text() });
  });
  page.on('pageerror', error => signals.push({ kind: 'console-error', message: error.message }));
  await page.addInitScript(initializePageProbes);
  await page.evaluate(initializePageProbes);
}

/** Drains event facts and newly observed or changed geometry facts from the current document. */
export async function collectSignals(
  page: Page,
  document?: JSHandle<Document>
): Promise<ProbeSignal[]> {
  const drain = () => {
    const probes = (globalThis as ProbeWindow).__playtestProbes;
    if (!probes) throw new Error('installProbes must be called before collectSignals');
    return probes.drain();
  };
  const signals = document ? await document.evaluate(drain) : await page.evaluate(drain);
  return [...signals, ...drainConsoleSignals(page)];
}
