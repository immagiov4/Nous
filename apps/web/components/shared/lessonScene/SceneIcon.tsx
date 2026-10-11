import { createContext, createElement, useContext, useEffect, useState } from 'react';

type IconNodes = Record<string, [string, Record<string, string>][]>;

// Shown when a stored icon name is missing from the installed Tabler version.
const FALLBACK_ICON = 'point';

let iconNodesPromise: Promise<IconNodes> | undefined;

const loadIconNodes = (): Promise<IconNodes> => {
  iconNodesPromise ??= import('@tabler-icon-nodes').then(
    module => module.default as unknown as IconNodes
  );
  return iconNodesPromise;
};

const IconNodesContext = createContext<IconNodes | null>(null);
export const ScenePrototypeContext = createContext(false);

/** Loads the Tabler outline path data once, lazily, for every icon of a scene. */
export const SceneIconProvider = ({
  children,
  prototype = false,
}: {
  readonly children: React.ReactNode;
  readonly prototype?: boolean;
}) => {
  const [nodes, setNodes] = useState<IconNodes | null>(null);
  useEffect(() => {
    let active = true;
    loadIconNodes()
      .then(loaded => {
        if (active) setNodes(loaded);
      })
      .catch(error => {
        // Icons are decorative: the scene text stays complete without them.
        console.error('Lesson scene icons could not be loaded.', error);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <ScenePrototypeContext.Provider value={prototype}>
      <IconNodesContext.Provider value={nodes}>{children}</IconNodesContext.Provider>
    </ScenePrototypeContext.Provider>
  );
};

const toReactAttributes = (attributes: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      value,
    ])
  );

/** A decorative Tabler outline icon; meaning always stays in the adjacent text. */
export const SceneIcon = ({
  className,
  name,
}: {
  readonly className?: string;
  readonly name: string;
}) => {
  const nodes = useContext(IconNodesContext);
  const masked = useContext(ScenePrototypeContext);
  // Stored names come from imported data, so only the catalog's own entries are looked up.
  const shapes = (nodes && Object.hasOwn(nodes, name) ? nodes[name] : nodes?.[FALLBACK_ICON]) ?? [];
  if (masked) {
    // The laboratory masks Tabler's original 2px outline; URLs stay local to the document.
    const body = shapes
      .map(
        ([tag, attributes]) =>
          `<${tag} ${Object.entries(attributes)
            .map(([key, value]) => `${key}="${value}"`)
            .join(' ')}/>`
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    return (
      <span
        aria-hidden="true"
        data-icon={name || FALLBACK_ICON}
        className={className ? `meaning-icon ${className}` : 'meaning-icon'}
        style={
          {
            '--icon-url': `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
          } as React.CSSProperties
        }
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={className ? `meaning-icon ${className}` : 'meaning-icon'}
      focusable="false"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.65}
      viewBox="0 0 24 24"
    >
      {shapes.map(([tag, attributes], index) =>
        // Path data order is stable per icon, so the index is a sufficient key.
        createElement(tag, { key: index, ...toReactAttributes(attributes) })
      )}
    </svg>
  );
};
