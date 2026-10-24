import { createContext } from 'react';

type Mermaid = typeof import('mermaid')['default'];

export type MermaidConfiguration = Parameters<Mermaid['initialize']>[0];
export type MermaidRenderCache = Map<string, Promise<string>>;
export const MermaidRenderCacheContext = createContext<MermaidRenderCache | null>(null);

let nextRenderId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs Mermaid tasks one at a time across every renderer: each task initializes Mermaid's global
 * configuration before rendering, so concurrent tasks would draw with each other's settings.
 */
export const runMermaidTask = <T>(task: (mermaid: Mermaid) => Promise<T>): Promise<T> => {
  const run = async () => task((await import('mermaid')).default);
  const result = renderQueue.then(run, run);
  renderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};

/** A unique element id for one Mermaid render. */
export const nextMermaidRenderId = (): string => `nous-mermaid-${++nextRenderId}`;

/** Reuses a completed diagram within its owner's lifetime, including its exact appearance. */
export async function renderConfiguredMermaid({
  code,
  configuration,
  cache,
  signal,
}: {
  code: string;
  configuration: MermaidConfiguration;
  cache?: MermaidRenderCache | null;
  signal?: AbortSignal;
}): Promise<string> {
  signal?.throwIfAborted();
  const key = JSON.stringify([code, configuration]);
  let pending = cache?.get(key);
  if (!pending) {
    pending = runMermaidTask(async mermaid => {
      // A shared preparation belongs to the cache owner, rather than one retiring view.
      if (!cache) signal?.throwIfAborted();
      mermaid.initialize(configuration);
      const { svg } = await mermaid.render(nextMermaidRenderId(), code);
      if (!cache) signal?.throwIfAborted();
      return svg;
    });
    cache?.set(key, pending);
    const request = pending;
    void pending.catch(() => {
      if (cache?.get(key) === request) cache.delete(key);
    });
  }
  const svg = await pending;
  signal?.throwIfAborted();
  return svg;
}

/** Renders Mermaid with the deploy's bundled version and no diagram callbacks. */
export const renderMermaidDiagram = (
  code: string,
  isDarkMode: boolean,
  signal: AbortSignal,
  cache?: MermaidRenderCache | null
): Promise<string> =>
  renderConfiguredMermaid({
    code,
    configuration: {
      securityLevel: 'strict',
      startOnLoad: false,
      theme: isDarkMode ? 'dark' : 'default',
    },
    signal,
    cache,
  });
