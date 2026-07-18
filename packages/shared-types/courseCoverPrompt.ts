export const COURSE_COVER_PROMPT_VERSION = 6;

export const COURSE_COVER_DOMINANT_COLORS = [
  'muted red',
  'burgundy',
  'earthy green',
  'muted copper',
  'ochre',
  'rust orange',
  'dark petrol green',
  'ink navy',
] as const;

export interface CourseCoverVisualDirection {
  composition: string;
  distinctiveDetails: string;
  dominantColor: (typeof COURSE_COVER_DOMINANT_COLORS)[number];
  subject: string;
}

export const COURSE_COVER_DIRECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dominantColor: { type: 'string', enum: COURSE_COVER_DOMINANT_COLORS },
    subject: { type: 'string' },
    composition: { type: 'string' },
    distinctiveDetails: { type: 'string' },
  },
  required: ['dominantColor', 'subject', 'composition', 'distinctiveDetails'],
} as const;

export const COURSE_COVER_DIRECTION_RESPONSE_FORMAT = {
  name: 'course_cover_visual_direction',
  strict: true,
  schema: COURSE_COVER_DIRECTION_JSON_SCHEMA,
} as const;

export const COURSE_COVER_DIRECTION_SYSTEM_PROMPT = `You are an editorial art director. Turn a course title and its short metadata into one highly specific, immediately recognizable cover concept.

Choose one strong subject-symbol or one tightly grouped micro-composition of at most a few substantial elements. It must communicate the course at thumbnail size through a clear silhouette and immediately recognizable topic-specific forms. Keep the motif at a moderate scale: generally no more than about two thirds of the canvas width or height, fully contained inside the frame, never touching or crossing an edge, and surrounded by an obvious band of negative space. Legibility does not mean making the subject enormous. Avoid dense panoramas, miniature worlds, crowds, dashboards, shelves of tiny objects, repeated small details, and collage-like compositions: they become visual noise in course cards. Do not default to a tactile material metaphor, photorealistic 3D render, or physical mockup.

Design for a responsive landscape card crop: keep the complete primary motif inside the central safe area, with generous breathing room on every side. Peripheral areas may contain only expendable background or simple continuation. Choose exactly one dominant identifying color from the approved palette — muted red, burgundy, earthy green, muted copper, ochre, rust orange, dark petrol green, or ink navy — according to the topic's mood and psychological associations. The palette must remain warm, muted, and compatible with the application's ivory, charcoal, copper, and stone tones. Ink navy is a near-black editorial blue, never vivid cobalt; dark petrol is a restrained blue-green, never bright cyan or teal. Never use electric blue, royal blue, saturated cyan, neon color, or the generic luminous-blue technology aesthetic. The chosen color must visibly govern the cover through the background, a large color field, or the principal subject; it must remain unmistakable in a tiny preview and must never be reduced to a few small accents. Use supporting neutrals and, only if necessary, one restrained secondary hue—never several competing saturated colors.

Avoid generic floating cubes, abstract networks, glowing nodes, random waves, and decorative geometry unless they are inherently relevant to the subject. Do not include words, letters, logos, watermarks, or UI.`;

export const buildCourseCoverDirectionUserPrompt = (title: string, context?: string): string =>
  `Course title: ${title}\nShort project context: ${context?.trim() || 'Not available'}`;

export const formatCourseCoverVisualDirection = (
  direction: Partial<CourseCoverVisualDirection>
): string | null => {
  const parts = [
    direction.subject,
    direction.composition,
    direction.distinctiveDetails,
    direction.dominantColor
      ? `Use ${direction.dominantColor} as the unmistakable dominant identifying color, not as a minor accent.`
      : null,
  ]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length === 4 ? parts.join(' ') : null;
};

export const buildFallbackCourseCoverVisualDirection = (title: string): string =>
  `One moderately sized subject-symbol or compact micro-composition unmistakably about ${title}, fully contained in the central area with generous negative space, using a clear silhouette and a few topic-specific forms rather than generic technology symbols, dense scenery, or default 3D materials. Choose muted red, burgundy, earthy green, muted copper, ochre, rust orange, dark petrol green, or ink navy as the dominant identifying color according to the topic, and apply it across a large visible area rather than as a minor accent. Keep the palette warm and muted; ink navy must be nearly black, with no vivid, electric, royal, cobalt, or cyan blue.`;

export const buildCourseCoverPrompt = (title: string, visualDirection: string): string =>
  `Create a refined editorial course cover for "${title}". Visual direction: ${visualDirection} Design it first as a distinctive thumbnail: one moderately sized subject-symbol or one compact micro-composition, a clear silhouette, few substantial shapes, and generous negative space. The motif must remain fully visible inside the central area and should not exceed roughly two thirds of the canvas in either dimension; never crop it or let it touch an edge. Use no dense panorama, miniature scene, collage, dashboard, crowd, or field of tiny repeated details. Wide landscape composition designed for a responsive centered card crop. The margins may contain only simple expendable background. The selected identifying color must dominate a substantial visible area and make the course recognizable by color alone at small size; neutrals are supporting colors only, with at most one restrained secondary hue. Keep every color muted and editorial: no electric, royal, cobalt, neon, or cyan blue. High-end educational publishing style, choose an illustrated, diagrammatic, drawn, or spatial treatment according to the subject instead of defaulting to 3D objects, restrained depth, no text, no letters, no logos, no UI, no watermark.`;
