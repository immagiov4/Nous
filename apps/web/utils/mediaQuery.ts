type MediaQueryChangeHandler = (event: MediaQueryListEvent) => void;

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: MediaQueryChangeHandler) => void;
  removeListener?: (listener: MediaQueryChangeHandler) => void;
};

export const subscribeToMediaQuery = (
  mediaQueryList: MediaQueryList,
  listener: MediaQueryChangeHandler
) => {
  const compatQueryList = mediaQueryList as LegacyMediaQueryList;

  if (typeof compatQueryList.addEventListener === 'function') {
    compatQueryList.addEventListener('change', listener);
    return () => {
      compatQueryList.removeEventListener?.('change', listener);
    };
  }

  if (typeof compatQueryList.addListener === 'function') {
    compatQueryList.addListener(listener);
    return () => {
      compatQueryList.removeListener?.(listener);
    };
  }

  return () => {};
};
