const COURSE_COVER_WIDTH = 960;
const COURSE_COVER_HEIGHT = 420;
const COURSE_COVER_WEBP_QUALITY = 0.84;

interface ImageDimensions {
  height: number;
  width: number;
}

interface SourceCrop {
  height: number;
  width: number;
  x: number;
  y: number;
}

export const calculateCourseCoverCrop = (
  source: ImageDimensions,
  target: ImageDimensions
): SourceCrop => {
  const sourceAspectRatio = source.width / source.height;
  const targetAspectRatio = target.width / target.height;

  if (sourceAspectRatio > targetAspectRatio) {
    const width = source.height * targetAspectRatio;
    return { height: source.height, width, x: (source.width - width) / 2, y: 0 };
  }

  const height = source.width / targetAspectRatio;
  return { height, width: source.width, x: 0, y: (source.height - height) / 2 };
};

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to decode the generated course cover.'));
    image.src = dataUrl;
  });

const canvasToWebp = (canvas: HTMLCanvasElement): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (!blob) {
          reject(new Error('Unable to encode the course cover as WebP.'));
          return;
        }

        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Unable to read the compressed course cover.'));
        reader.readAsDataURL(blob);
      },
      'image/webp',
      COURSE_COVER_WEBP_QUALITY
    );
  });

export const optimizeCourseCoverDataUrl = async (dataUrl: string): Promise<string> => {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = COURSE_COVER_WIDTH;
  canvas.height = COURSE_COVER_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas is unavailable while optimizing the course cover.');
  }

  const crop = calculateCourseCoverCrop(
    { height: image.naturalHeight, width: image.naturalWidth },
    { height: COURSE_COVER_HEIGHT, width: COURSE_COVER_WIDTH }
  );
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    COURSE_COVER_WIDTH,
    COURSE_COVER_HEIGHT
  );
  return canvasToWebp(canvas);
};
