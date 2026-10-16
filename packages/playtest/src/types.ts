export const PRODUCT_SURFACES = [
  'contextual-chat',
  'course-outline',
  'generation',
  'home-chat',
  'lesson-reader',
  'lesson-visuals',
  'library',
  'settings',
] as const;
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];

export type StoryKind = 'check' | 'mission';
export type Viewport = 'desktop' | 'mobile';

export type Story = {
  id: string;
  kind: StoryKind;
  title: string;
  persona?: string;
  viewports: Viewport[];
  requires: Record<string, unknown>;
  surfaces: ProductSurface[];
  tags: string[];
  budget: { steps: number };
  body: string;
  sourcePath: string;
};

export type Persona = {
  id: string;
  device?: Viewport;
  affects?: string[];
  body: string;
  sourcePath: string;
};
export type StoryFilter = { ids?: string[]; tags?: string[]; kinds?: StoryKind[] };
