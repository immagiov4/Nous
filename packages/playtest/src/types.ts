export type StoryKind = 'check' | 'mission';
export type Viewport = 'desktop' | 'mobile';

export type Story = {
  id: string;
  kind: StoryKind;
  title: string;
  persona?: string;
  viewports: Viewport[];
  requires: Record<string, unknown>;
  tags: string[];
  budget: { steps: number };
  body: string;
  sourcePath: string;
};

export type Persona = { id: string; device?: Viewport; body: string; sourcePath: string };
export type StoryFilter = { ids?: string[]; tags?: string[]; kinds?: StoryKind[] };
