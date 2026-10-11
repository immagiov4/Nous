import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaytestAdapter } from '../../packages/playtest/src/adapter';
import { prepare } from './prepare';
import { APP_URL, BACKEND_URL, dataRoot, ensureStack } from './stack';

const HTTP_SERVER_ERROR = 500;
const adapter: PlaytestAdapter = {
  appDescription: () =>
    'Nous ti aiuta a comprendere intere materie a partire dal tuo materiale, accompagnandoti nello studio un passo alla volta con spiegazioni e attività pensate anche per chi fatica a mantenere l’attenzione.',
  describeAffect: affect =>
    `Stato emotivo iniziale per questa sessione: ${affect}. Cambia solo in risposta a ciò che incontri.`,
  baseUrl: () => APP_URL,
  locale: () => 'it-IT',
  ensureStack,
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
    const text = readFileSync(join(dataRoot(), 'complaint-mining/TAXONOMY.md'), 'utf8');
    const section =
      /^## Family matrix for the checker prompt\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);
    if (!section) throw new Error('Taxonomy family matrix is missing.');
    return section[1].trim();
  },
  taxonomyClasses() {
    return [...new Set(this.taxonomy().match(/\bD\d+\b/g) ?? [])];
  },
  thresholds: () => ({}),
};
export default adapter;
