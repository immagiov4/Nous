export interface ProjectAssetRef {
  readonly byteSize: number;
  readonly hash: string;
  readonly id: string;
  readonly mediaType: string;
}

const PROJECT_ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u;
const PROJECT_ASSET_PLACEHOLDER_PATTERN = /\{\{PROJECT_ASSET:([a-f0-9]{64})\}\}/gu;
const PROJECT_ASSET_PLACEHOLDER_PREFIX = '{{PROJECT_ASSET:';
const PROJECT_ASSET_PLACEHOLDER_SUFFIX = '}}';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isProjectAssetId = (value: unknown): value is string =>
  typeof value === 'string' && PROJECT_ASSET_ID_PATTERN.test(value);

export const buildProjectAssetPlaceholder = (assetId: string): string =>
  `${PROJECT_ASSET_PLACEHOLDER_PREFIX}${assetId}${PROJECT_ASSET_PLACEHOLDER_SUFFIX}`;

export const normalizeProjectAssetMediaType = (value: string | null | undefined): string =>
  (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';

export const isValidProjectAssetRef = (value: unknown): value is ProjectAssetRef =>
  isRecord(value) &&
  Number.isSafeInteger(value.byteSize) &&
  (value.byteSize as number) >= 0 &&
  isProjectAssetId(value.hash) &&
  isProjectAssetId(value.id) &&
  typeof value.mediaType === 'string' &&
  Boolean(normalizeProjectAssetMediaType(value.mediaType));

export const projectAssetRefsMatch = (left: ProjectAssetRef, right: ProjectAssetRef): boolean =>
  left.byteSize === right.byteSize &&
  left.hash === right.hash &&
  left.id === right.id &&
  left.mediaType === right.mediaType;

export type ProjectAssetHtmlReferenceValidation =
  | {
      readonly reason: 'asset-reference-invalid' | 'placeholder-invalid';
      readonly valid: false;
    }
  | {
      readonly refsById: ReadonlyMap<string, ProjectAssetRef>;
      readonly valid: true;
    };

export const validateProjectAssetHtmlReferences = (
  code: string,
  embeddedAssets: readonly unknown[]
): ProjectAssetHtmlReferenceValidation => {
  const refsById = new Map<string, ProjectAssetRef>();
  for (const value of embeddedAssets) {
    if (!isValidProjectAssetRef(value)) {
      return { reason: 'asset-reference-invalid', valid: false };
    }
    const existing = refsById.get(value.id);
    if (existing && !projectAssetRefsMatch(existing, value)) {
      return { reason: 'asset-reference-invalid', valid: false };
    }
    refsById.set(value.id, value);
  }

  const placeholderIds = new Set(
    Array.from(code.matchAll(PROJECT_ASSET_PLACEHOLDER_PATTERN), match => match[1] ?? '')
  );
  const malformedPlaceholder = code
    .replaceAll(PROJECT_ASSET_PLACEHOLDER_PATTERN, '')
    .includes(PROJECT_ASSET_PLACEHOLDER_PREFIX);
  if (
    malformedPlaceholder ||
    placeholderIds.size !== refsById.size ||
    [...placeholderIds].some(id => !refsById.has(id))
  ) {
    return { reason: 'placeholder-invalid', valid: false };
  }
  return { refsById, valid: true };
};

export interface ProjectDocumentImageAsset {
  readonly asset: ProjectAssetRef;
  readonly caption?: string;
  readonly id: string;
  readonly intrinsicHeight?: number;
  readonly intrinsicWidth?: number;
  readonly pageNumber?: number;
  readonly sourceHash?: string;
  readonly sourceId?: string;
  readonly sourceOrder: number;
  readonly textAfter: string;
  readonly textBefore: string;
  readonly textCurrent?: string;
}

export type ProjectVisual =
  | {
      readonly asset: ProjectAssetRef;
      readonly kind: 'image';
    }
  | {
      readonly code: string;
      readonly embeddedAssets: readonly ProjectAssetRef[];
      readonly kind: 'html';
    }
  | {
      readonly code: string;
      readonly kind: 'svg';
    }
  | {
      readonly code: string;
      readonly kind: 'mermaid';
    };

export interface ProjectLessonVisual {
  readonly altText?: string;
  readonly anchorHeading?: string;
  readonly createdAt: string;
  readonly id: string;
  readonly render: ProjectVisual;
  readonly slotId: string;
  readonly title?: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isValidProjectVisual = (value: unknown): value is ProjectVisual => {
  if (!isRecord(value)) return false;
  if (value.kind === 'image') return isValidProjectAssetRef(value.asset);
  if (value.kind === 'html') {
    return (
      isNonEmptyString(value.code) &&
      Array.isArray(value.embeddedAssets) &&
      value.embeddedAssets.every(isValidProjectAssetRef)
    );
  }
  return (value.kind === 'mermaid' || value.kind === 'svg') && isNonEmptyString(value.code);
};

const isOptionalNonEmptyString = (value: unknown): boolean =>
  value === undefined || isNonEmptyString(value);

export const isValidProjectLessonVisual = (value: unknown): value is ProjectLessonVisual =>
  isRecord(value) &&
  isNonEmptyString(value.createdAt) &&
  isNonEmptyString(value.id) &&
  isValidProjectVisual(value.render) &&
  isNonEmptyString(value.slotId) &&
  isOptionalNonEmptyString(value.altText) &&
  isOptionalNonEmptyString(value.anchorHeading) &&
  isOptionalNonEmptyString(value.title);
