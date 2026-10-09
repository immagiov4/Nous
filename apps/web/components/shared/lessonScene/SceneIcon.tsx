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

/** Loads the Tabler outline path data once, lazily, for every icon of a scene. */
export const SceneIconProvider = ({ children }: { readonly children: React.ReactNode }) => {
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
  return <IconNodesContext.Provider value={nodes}>{children}</IconNodesContext.Provider>;
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
  const shapes = nodes?.[name] ?? nodes?.[FALLBACK_ICON] ?? [];
  return (
    <svg
      aria-hidden="true"
      className={`meaning-icon${className ? ` ${className}` : ''}`}
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
