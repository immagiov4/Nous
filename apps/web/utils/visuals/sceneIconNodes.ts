export type IconNodes = Record<string, [string, Record<string, string>][]>;

let loadedNodes: IconNodes | null = null;
let loadingNodes: Promise<IconNodes> | undefined;

/** Share the installed outline paths across playback preparation and scene rendering. */
export const loadSceneIconNodes = (): Promise<IconNodes> => {
  loadingNodes ??= import('@tabler-icon-nodes').then(module => {
    loadedNodes = module.default as unknown as IconNodes;
    return loadedNodes;
  });
  return loadingNodes;
};

/** A mounted scene can render paths immediately when preparation has loaded them. */
export const readSceneIconNodes = (): IconNodes | null => loadedNodes;
