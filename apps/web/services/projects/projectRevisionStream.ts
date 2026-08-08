import { PROJECT_REVISION_RESYNC_EVENT } from '@shared/projectContract';

import type { ProjectRevisionEvent } from '../../types.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';

const RECONNECT_DELAY_MS = 2_000;

const readProjectRevisionEvent = (data: string): ProjectRevisionEvent | null => {
  try {
    const event = JSON.parse(data) as Partial<ProjectRevisionEvent>;
    if (
      typeof event.projectId !== 'string' ||
      !Number.isSafeInteger(event.revision) ||
      (event.revision || 0) < 1
    ) {
      return null;
    }

    return {
      projectId: event.projectId,
      revision: event.revision as number,
      ...(event.deleted === true ? { deleted: true } : {}),
    };
  } catch {
    return null;
  }
};

export const consumeProjectRevisionStream = async (
  stream: ReadableStream<Uint8Array>,
  listener: (event: ProjectRevisionEvent) => void,
  onResync: () => void = () => undefined
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const messages = buffer.split(/\r?\n\r?\n/);
    buffer = messages.pop() || '';

    for (const message of messages) {
      const lines = message.split(/\r?\n/);
      const eventName = lines
        .find(line => line.startsWith('event:'))
        ?.slice(6)
        .trimStart();
      if (eventName === PROJECT_REVISION_RESYNC_EVENT) {
        onResync();
        continue;
      }
      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      const event = data ? readProjectRevisionEvent(data) : null;
      if (event) {
        listener(event);
      }
    }

    if (done) {
      return;
    }
  }
};

export const subscribeToProjectRevisionStream = ({
  listener,
  onCatchUp,
  url,
}: {
  listener: (event: ProjectRevisionEvent) => void;
  onCatchUp: () => void;
  url: string;
}): (() => void) => {
  let abortController: AbortController | null = null;
  let reconnectTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let stopped = false;

  const connect = async (): Promise<void> => {
    abortController = new AbortController();
    try {
      const response = await fetchWithSupabaseAuth(url, {
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Project revision stream unavailable (${response.status}).`);
      }
      onCatchUp();
      await consumeProjectRevisionStream(response.body, listener, onCatchUp);
    } catch (error) {
      if (!stopped && !(error instanceof Error && error.name === 'AbortError')) {
        console.warn('[Nous] Project revision stream disconnected', error);
      }
    }

    if (!stopped) {
      reconnectTimeout = globalThis.setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    }
  };

  void connect();
  return () => {
    stopped = true;
    abortController?.abort();
    if (reconnectTimeout) {
      globalThis.clearTimeout(reconnectTimeout);
    }
  };
};
