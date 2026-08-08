export interface ProjectAssetDownload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface ProjectAssetReader {
  readActive(input: {
    assetId: string;
    projectId: string;
    userId: string;
  }): Promise<ProjectAssetDownload | null>;
}

export class ProjectAssetReaderUnavailableError extends Error {
  constructor() {
    super('Project asset reader is unavailable.');
    this.name = 'ProjectAssetReaderUnavailableError';
  }
}

export const unavailableProjectAssetReader: ProjectAssetReader = {
  readActive: () => Promise.reject(new ProjectAssetReaderUnavailableError()),
};
