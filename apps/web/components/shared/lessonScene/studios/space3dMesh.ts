import { interVariable } from '@shared/lessonStudios/interVariable';
import type { buildSpace3d } from '@shared/lessonStudios/space3d';
import { STUDIO_INTER_FONT_FAMILY } from '@shared/lessonStudios/studioTypography';
import { Vector2, WebGLRenderer } from 'three';

let loadedFont: Promise<FontFace> | undefined;

export function loadSpace3dFont() {
  loadedFont ??= new FontFace(
    STUDIO_INTER_FONT_FAMILY,
    `url(data:font/woff2;base64,${interVariable})`,
    {
      weight: '100 900',
    }
  )
    .load()
    .then(font => {
      document.fonts.add(font);
      return font;
    })
    .catch((error: unknown) => {
      loadedFont = undefined;
      throw error;
    });
  return loadedFont;
}

export function getSpace3dColors(root: HTMLElement) {
  const styles = getComputedStyle(root);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    ink: token('--ink'),
    surface: token('--surface'),
    accent: token('--accent'),
    near: token('--chart-1'),
    far: token('--chart-2'),
    empty: token('--chart-4'),
  };
}

export function mountSpace3d(root: HTMLElement, onContextLost: () => void) {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  const canvas = renderer.domElement;
  canvas.className = 'space-3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.addEventListener('webglcontextlost', onContextLost);
  const size = new Vector2();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearAlpha(0);
  root.prepend(canvas);
  return {
    paint({ scene, camera, width, height }: ReturnType<typeof buildSpace3d>['mesh']) {
      if (renderer.getPixelRatio() !== window.devicePixelRatio)
        renderer.setPixelRatio(window.devicePixelRatio);
      renderer.getSize(size);
      if (size.x !== Math.floor(width) || size.y !== Math.floor(height)) {
        renderer.setSize(Math.floor(width), Math.floor(height), false);
      }
      renderer.render(scene, camera);
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
