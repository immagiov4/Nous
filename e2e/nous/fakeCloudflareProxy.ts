import { createServer, request } from 'node:http';
import {
  SOURCE_TRANSFER_LIMITS,
  type SourceTransferLimitModel,
} from '../../packages/shared-types/sourceTransfer';

/** Streams HTTP in both directions while enforcing the same effective proxy contract as ingestion. */
export const createFakeCloudflareProxy = ({
  target,
  limits = SOURCE_TRANSFER_LIMITS,
}: {
  target: string;
  limits?: Readonly<SourceTransferLimitModel>;
}) => {
  const origin = new URL(target);
  if (origin.protocol !== 'http:') throw new Error('The loopback proxy requires an HTTP origin');
  return createServer((incoming, outgoing) => {
    const destination = new URL(incoming.url ?? '/', origin);
    if (destination.origin !== origin.origin) {
      outgoing.writeHead(400).end();
      return;
    }
    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const clearTimers = () => {
      clearTimeout(writeTimer);
      clearTimeout(readTimer);
    };
    const upstream = request(destination, {
      method: incoming.method,
      headers: { ...incoming.headers, host: origin.host },
    });
    const fail = (status: number, code: string) => {
      if (failed) return;
      failed = true;
      clearTimers();
      incoming.unpipe(upstream);
      upstream.destroy();
      incoming.resume();
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      outgoing.end(JSON.stringify({ success: false, code, layer: 'fake-cloudflare' }));
    };
    upstream.on('error', () => {
      if (!failed) fail(502, 'FAKE_PROXY_ORIGIN_UNAVAILABLE');
    });
    outgoing.once('close', () => {
      clearTimers();
      upstream.destroy();
    });
    incoming.once('aborted', () => {
      clearTimers();
      upstream.destroy();
    });
    const declaredBytes = Number(incoming.headers['content-length'] ?? 0);
    if (declaredBytes > limits.maxRequestBytes) {
      fail(413, 'FAKE_PROXY_BODY_LIMIT');
      return;
    }
    let bytes = 0;
    incoming.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limits.maxRequestBytes) fail(413, 'FAKE_PROXY_BODY_LIMIT');
    });
    writeTimer = setTimeout(
      () => fail(504, 'FAKE_PROXY_ORIGIN_WRITE_LIMIT'),
      limits.originWriteTimeoutMs
    );
    upstream.once('finish', () => {
      clearTimeout(writeTimer);
      if (!failed)
        readTimer = setTimeout(
          () => fail(504, 'FAKE_PROXY_FIRST_BYTE_LIMIT'),
          limits.firstByteTimeoutMs
        );
    });
    upstream.once('response', response => {
      clearTimers();
      if (failed) {
        response.destroy();
        return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.pipe(outgoing);
      response.once('error', () => outgoing.destroy());
    });
    incoming.pipe(upstream);
  });
};
