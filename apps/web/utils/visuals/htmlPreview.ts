import { GENERATED_VISUAL_HOST_STYLES } from './generatedVisualHost.ts';

const PREVIEW_WIDTH = 680;
const MAX_PREVIEW_HEIGHT = 1200;
const RENDER_SETTLE_MS = 100;

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Impossibile acquisire la bozza HTML.'));
    image.src = url;
  });

export const renderHtmlPreview = async (htmlCode: string): Promise<string> => {
  const messageToken = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.sandbox.add('allow-scripts');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${PREVIEW_WIDTH}px;border:0;`;
  frame.srcdoc = `<style>${GENERATED_VISUAL_HOST_STYLES}</style>${htmlCode}<script>
setTimeout(() => {
  for (const canvas of document.querySelectorAll('canvas')) {
    try {
      const image = document.createElement('img');
      image.src = canvas.toDataURL('image/png');
      image.width = canvas.width;
      image.height = canvas.height;
      canvas.replaceWith(image);
    } catch {}
  }
  parent.postMessage({
    type: 'nous-html-preview',
    token: ${JSON.stringify(messageToken)},
    body: new XMLSerializer().serializeToString(document.body),
    height: document.documentElement.scrollHeight
  }, '*');
}, ${RENDER_SETTLE_MS});
</script>`;
  document.body.append(frame);

  try {
    const snapshot = await new Promise<{ body: string; height: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', receiveSnapshot);
        reject(new Error('La bozza HTML non ha completato il rendering.'));
      }, 3000);
      const receiveSnapshot = (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.type !== 'nous-html-preview' ||
          event.data?.token !== messageToken
        ) {
          return;
        }
        clearTimeout(timeout);
        window.removeEventListener('message', receiveSnapshot);
        resolve({ body: String(event.data.body), height: Number(event.data.height) });
      };
      window.addEventListener('message', receiveSnapshot);
    });
    const height = Math.min(MAX_PREVIEW_HEIGHT, Math.max(1, snapshot.height));
    const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${height}"><foreignObject width="100%" height="100%">${snapshot.body}</foreignObject></svg>`;
    const url = URL.createObjectURL(new Blob([previewSvg], { type: 'image/svg+xml' }));

    try {
      const image = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = PREVIEW_WIDTH;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Canvas non disponibile per la revisione HTML.');
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    frame.remove();
  }
};
