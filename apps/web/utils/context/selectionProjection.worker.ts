import { buildVisibleProjection } from '../markdown/textProjection.ts';

self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(buildVisibleProjection(event.data).text);
};
