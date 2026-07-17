export const COURSE_COVER_PROMPT_VERSION = 2;

export interface CourseCoverVisualDirection {
  composition: string;
  distinctiveDetails: string;
  subject: string;
}

export const COURSE_COVER_DIRECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string' },
    composition: { type: 'string' },
    distinctiveDetails: { type: 'string' },
  },
  required: ['subject', 'composition', 'distinctiveDetails'],
} as const;

export const COURSE_COVER_DIRECTION_RESPONSE_FORMAT = {
  name: 'course_cover_visual_direction',
  strict: true,
  schema: COURSE_COVER_DIRECTION_JSON_SCHEMA,
} as const;

export const COURSE_COVER_DIRECTION_SYSTEM_PROMPT = `You are an editorial art director. Turn a course title and its short metadata into one highly specific, immediately recognizable cover concept.

Choose the clearest visual form for the topic: an editorial illustration, a diagrammatic composition, a concrete scene, or a recognizable object. Do not default to a tactile material metaphor, photorealistic 3D render, or physical mockup. Describe the viewpoint and composition, then add distinctive subject-specific details that separate this course from unrelated courses. Avoid generic floating cubes, abstract networks, glowing nodes, random waves, and decorative geometry unless they are inherently relevant to the subject. Do not include words, letters, logos, watermarks, or UI. Do not prescribe a visual style or color palette; the renderer applies the publication style.`;

export const buildCourseCoverDirectionUserPrompt = (title: string, context?: string): string =>
  `Course title: ${title}\nShort project context: ${context?.trim() || 'Not available'}`;

export const formatCourseCoverVisualDirection = (
  direction: Partial<CourseCoverVisualDirection>
): string | null => {
  const parts = [direction.subject, direction.composition, direction.distinctiveDetails]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length === 3 ? parts.join(' ') : null;
};

export const buildFallbackCourseCoverVisualDirection = (title: string): string =>
  `A subject-specific editorial illustration, diagrammatic composition, scene, or recognizable object that is unmistakably about ${title}, using topic-specific details rather than generic abstract technology symbols or default 3D materials.`;

export const buildCourseCoverPrompt = (title: string, visualDirection: string): string =>
  `Create a refined editorial course cover for "${title}". Visual direction: ${visualDirection} Wide landscape composition that remains clear after a centered card crop, elegant warm ivory and charcoal palette with one muted copper accent, high-end educational publishing style, choose illustration, diagrammatic, drawn, or spatial treatment according to the subject instead of defaulting to 3D objects, generous negative space, restrained depth, no text, no letters, no logos, no UI, no watermark.`;
