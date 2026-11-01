import { readFileSync } from 'node:fs';
import type { PlaytestAdapter } from '../../packages/playtest/src/adapter';
import { privateFixtureSkipReason } from './fixtures';
import { prepare } from './prepare';
import { APP_URL, BACKEND_URL, ensureStack } from './stack';

const HTTP_SERVER_ERROR = 500;
const adapter: PlaytestAdapter = {
  appDescription: () =>
    'Nous ti aiuta a comprendere intere materie a partire dal tuo materiale, accompagnandoti nello studio un passo alla volta con spiegazioni e attività pensate anche per chi fatica a mantenere l’attenzione.',
  describeAffect: affect =>
    `Stato emotivo iniziale per questa sessione: ${affect}. Cambia solo in risposta a ciò che incontri.`,
  baseUrl: () => APP_URL,
  locale: () => 'it-IT',
  ensureStack,
  skipReason: privateFixtureSkipReason,
  prepare,
  classify(event) {
    if (event.kind !== 'response' || event.status < HTTP_SERVER_ERROR) return { stop: false };
    const url = new URL(event.url);
    // Vite proxies API traffic, so browser responses retain the frontend origin.
    const backend =
      url.origin === BACKEND_URL || (url.origin === APP_URL && url.pathname.startsWith('/api/'));
    return backend
      ? {
          stop: true,
          reason: `Backend HTTP ${event.status}.`,
          correlationId: event.headers['x-request-id'],
        }
      : { stop: false };
  },
  styleReference: () => [],
  taxonomy() {
    return readFileSync(new URL('../../docs/VISUAL_DEFECTS.md', import.meta.url), 'utf8').trim();
  },
  taxonomyClasses() {
    return [...new Set(this.taxonomy().match(/\bD\d+\b/g) ?? [])];
  },
  thresholds: () => ({}),
  probeClass: kind =>
    ({
      'clipped-text': 'D01',
      overlap: 'D02',
      'layout-shift': 'D11',
      'gesture-target-movement': 'D10',
      'interaction-latency': 'D12',
      contrast: 'D05',
      'horizontal-overflow': undefined,
      'console-error': undefined,
    })[kind],
};
export default adapter;
