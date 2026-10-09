type Mermaid = typeof import('mermaid')['default'];

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

/** Renders Mermaid with the deploy's bundled version and no diagram callbacks. */
export const renderMermaidDiagram = (
  code: string,
  isDarkMode: boolean,
  signal: AbortSignal
): Promise<string> =>
  runMermaidTask(async mermaid => {
    signal.throwIfAborted();
    mermaid.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: isDarkMode ? 'dark' : 'default',
    });
    const { svg } = await mermaid.render(nextMermaidRenderId(), code);
    signal.throwIfAborted();
    return svg;
  });
