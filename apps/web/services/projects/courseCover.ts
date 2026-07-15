import type { FileData } from '../../types.ts';
import { optimizeCourseCoverDataUrl } from '../../utils/visuals/courseCoverImage.ts';
import { callOpenRouter } from '../openrouter/client.ts';
import { MODEL_ASSESSMENT } from '../openrouter/config.ts';
import { requestGeneratedImage } from '../openrouter/imageClient.ts';
import { parseCleanJson } from '../openrouter/json.ts';

const coverGenerationByProjectId = new Map<string, Promise<string>>();
const COURSE_COVER_PROMPT_VERSION = 2;
const COURSE_COVER_STORAGE_VERSION = 3;

type CoverLoader = (projectId: string) => Promise<FileData | null>;
interface CoverStorageCircuit {
  probe: Promise<void> | null;
  status: 'available' | 'unavailable' | 'unknown';
}
const coverStorageCircuitByLoader = new WeakMap<CoverLoader, CoverStorageCircuit>();

const assertCoverStorageAvailable = async (
  loadCover: CoverLoader,
  projectId: string
): Promise<void> => {
  const circuit = coverStorageCircuitByLoader.get(loadCover) || {
    probe: null,
    status: 'unknown' as const,
  };
  coverStorageCircuitByLoader.set(loadCover, circuit);
  if (circuit.status === 'unavailable') {
    throw new Error('Course cover storage is unavailable for this session.');
  }
  if (circuit.status === 'available') return;

  circuit.probe ||= loadCover(projectId)
    .then(() => {
      circuit.status = 'available';
    })
    .catch(error => {
      circuit.status = 'unavailable';
      throw error;
    })
    .finally(() => {
      circuit.probe = null;
    });
  await circuit.probe;
};

interface CourseCoverVisualDirection {
  composition: string;
  distinctiveDetails: string;
  subject: string;
}

const COURSE_COVER_DIRECTION_SCHEMA = {
  name: 'course_cover_visual_direction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      subject: { type: 'string' },
      composition: { type: 'string' },
      distinctiveDetails: { type: 'string' },
    },
    required: ['subject', 'composition', 'distinctiveDetails'],
  },
} as const;

const planCourseCoverVisualDirection = async (title: string, context?: string): Promise<string> => {
  try {
    const response = await callOpenRouter({
      model: MODEL_ASSESSMENT,
      modelSlot: 'assessment',
      max_tokens: 420,
      messages: [
        {
          role: 'system',
          content: `You are an editorial art director. Turn a course title and its short metadata into one highly specific, immediately recognizable cover concept.

Choose a concrete subject or material metaphor that genuinely belongs to the topic. Describe the camera/viewpoint and composition, then add distinctive physical details that separate this course from unrelated courses. Avoid generic floating cubes, abstract networks, glowing nodes, random waves, and decorative geometry unless they are inherently relevant to the subject. Do not include words, letters, logos, watermarks, or UI. Do not prescribe a visual style or color palette; the renderer applies the publication style.`,
        },
        {
          role: 'user',
          content: `Course title: ${title}\nShort project context: ${context?.trim() || 'Not available'}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: COURSE_COVER_DIRECTION_SCHEMA,
      },
    });
    const direction = parseCleanJson<CourseCoverVisualDirection>(response);
    const parts = [direction.subject, direction.composition, direction.distinctiveDetails]
      .map(part => part?.trim())
      .filter(Boolean);
    if (parts.length === 3) {
      return parts.join(' ');
    }
  } catch {
    // Image generation can still produce a useful fallback if visual planning is unavailable.
  }

  return `A concrete, subject-specific scene or material metaphor that is unmistakably about ${title}, with topic-specific objects and details rather than generic abstract technology symbols.`;
};

const buildCourseCoverPrompt = (title: string, visualDirection: string): string =>
  `Create a refined editorial course cover for "${title}". Visual direction: ${visualDirection} Landscape 16:7 composition, elegant warm ivory and charcoal palette with one muted copper accent, high-end educational publishing style, restrained tactile materials, generous negative space, subtle depth, no text, no letters, no logos, no UI, no watermark.`;

const isCoverAtVersion = (cover: FileData, version: number): boolean =>
  cover.name.includes(`-cover-v${version}.`);

export const getProjectCoverDataUrl = (file: FileData): string | undefined =>
  file.data ? `data:${file.mimeType || 'application/octet-stream'};base64,${file.data}` : undefined;

const fileFromDataUrl = (projectId: string, dataUrl: string, version: number): FileData => {
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
  return {
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mimeType,
    name: `${projectId}-cover-v${version}.${mimeType.split('/')[1] || 'png'}`,
  };
};

const generateProjectCoverDataUrl = async (title: string, context?: string): Promise<string> => {
  const visualDirection = await planCourseCoverVisualDirection(title, context);
  const image = await requestGeneratedImage(buildCourseCoverPrompt(title, visualDirection));
  return image.dataUrl;
};

export const ensureProjectCover = ({
  loadCover,
  projectId,
  saveCover,
  title,
  context,
  optimizeCover = optimizeCourseCoverDataUrl,
}: {
  context?: string;
  loadCover: (projectId: string) => Promise<FileData | null>;
  optimizeCover?: (dataUrl: string) => Promise<string>;
  projectId: string;
  saveCover: (projectId: string, cover: FileData) => Promise<void>;
  title: string;
}): Promise<string> => {
  const existingGeneration = coverGenerationByProjectId.get(projectId);
  if (existingGeneration) return existingGeneration;

  const generation = (async () => {
    await assertCoverStorageAvailable(loadCover, projectId);
    const storedCover = await loadCover(projectId);
    const storedCoverUrl = storedCover ? getProjectCoverDataUrl(storedCover) : undefined;
    if (
      storedCover &&
      storedCoverUrl &&
      isCoverAtVersion(storedCover, COURSE_COVER_STORAGE_VERSION)
    ) {
      return storedCoverUrl;
    }

    const sourceDataUrl =
      storedCover && storedCoverUrl && isCoverAtVersion(storedCover, COURSE_COVER_PROMPT_VERSION)
        ? storedCoverUrl
        : await generateProjectCoverDataUrl(title, context);

    let optimizedDataUrl: string;
    try {
      optimizedDataUrl = await optimizeCover(sourceDataUrl);
    } catch {
      if (storedCoverUrl) return storedCoverUrl;
      await saveCover(
        projectId,
        fileFromDataUrl(projectId, sourceDataUrl, COURSE_COVER_PROMPT_VERSION)
      );
      return sourceDataUrl;
    }

    await saveCover(
      projectId,
      fileFromDataUrl(projectId, optimizedDataUrl, COURSE_COVER_STORAGE_VERSION)
    );
    return optimizedDataUrl;
  })().finally(() => coverGenerationByProjectId.delete(projectId));

  coverGenerationByProjectId.set(projectId, generation);
  return generation;
};
