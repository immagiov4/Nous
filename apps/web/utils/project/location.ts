const PROJECT_QUERY_PARAM = 'project';

const normalizeProjectId = (projectId: string | null | undefined): string | null => {
  const normalized = projectId?.trim() || '';
  return normalized.length > 0 ? normalized : null;
};

export const getProjectIdFromLocation = (
  locationLike: Pick<Location, 'search'> | string
): string | null => {
  const search = typeof locationLike === 'string' ? locationLike : locationLike.search;
  const params = new URLSearchParams(search);
  return normalizeProjectId(params.get(PROJECT_QUERY_PARAM));
};

export const buildProjectLocationHref = (
  locationLike: Pick<Location, 'pathname' | 'search' | 'hash'>,
  projectId: string | null
): string => {
  const params = new URLSearchParams(locationLike.search);
  const normalizedProjectId = normalizeProjectId(projectId);

  if (normalizedProjectId) {
    params.set(PROJECT_QUERY_PARAM, normalizedProjectId);
  } else {
    params.delete(PROJECT_QUERY_PARAM);
  }

  const nextSearch = params.toString();
  const hash = locationLike.hash || '';
  return `${locationLike.pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
};
