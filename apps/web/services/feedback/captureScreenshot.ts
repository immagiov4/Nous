import type { FeedbackScreenshot } from './feedbackApi.ts';

const MAX_SCREENSHOT_WIDTH = 1_280;
const MAX_SCREENSHOT_HEIGHT = 720;
const MAX_SCREENSHOT_BYTES = 750_000;
const SCREENSHOT_QUALITY = 0.68;

const waitForVideoFrame = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve, reject) => {
    video.onloadedmetadata = () => {
      void video.play().then(() => requestAnimationFrame(() => resolve()), reject);
    };
    video.onerror = () => reject(new Error('Screenshot video unavailable'));
  });

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Screenshot encoding unavailable'))),
      'image/webp',
      SCREENSHOT_QUALITY
    );
  });

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Screenshot reading unavailable'));
    reader.readAsDataURL(blob);
  });

const captureVideoFrame = async (stream: MediaStream): Promise<FeedbackScreenshot> => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const videoFrameReady = waitForVideoFrame(video);
  video.srcObject = stream;
  await videoFrameReady;

  const scale = Math.min(
    1,
    MAX_SCREENSHOT_WIDTH / video.videoWidth,
    MAX_SCREENSHOT_HEIGHT / video.videoHeight
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot canvas unavailable');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await canvasToBlob(canvas);
  if (blob.size > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot exceeds size limit');
  return { dataUrl: await blobToDataUrl(blob) };
};

const stopStream = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

export const captureFeedbackScreenshot = async (): Promise<FeedbackScreenshot> => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture unavailable');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
  try {
    return await captureVideoFrame(stream);
  } finally {
    stopStream(stream);
  }
};
