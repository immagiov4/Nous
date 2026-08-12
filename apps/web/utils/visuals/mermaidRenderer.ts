let nextRenderId = 0;
let renderQueue = Promise.resolve();

/** Renders Mermaid with the deploy's bundled version and no diagram callbacks. */
export const renderMermaidDiagram = (
  code: string,
  isDarkMode: boolean,
  signal: AbortSignal
): Promise<string> => {
  const render = async (): Promise<string> => {
    signal.throwIfAborted();
    const { default: mermaid } = await import('mermaid');
    signal.throwIfAborted();
    mermaid.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: isDarkMode ? 'dark' : 'default',
    });
    const { svg } = await mermaid.render(`nous-mermaid-${++nextRenderId}`, code);
    signal.throwIfAborted();
    return svg;
  };

  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};
