import type { Page } from 'playwright';
import { initializePageProbes, type ProbeSignal, type ProbeWindow } from './pageProbes';

const consoleSignals = new WeakMap<Page, ProbeSignal[]>();

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
export async function collectSignals(page: Page): Promise<ProbeSignal[]> {
  const signals = await page.evaluate(() => {
    const probes = (globalThis as ProbeWindow).__playtestProbes;
    if (!probes) throw new Error('installProbes must be called before collectSignals');
    return probes.drain();
  });
  return [...signals, ...(consoleSignals.get(page)?.splice(0) ?? [])];
}
