// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { atlasStageReady } from '../atlas/dom';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('keeps unfinished diagrams unready with a paused animation clock', () => {
  vi.stubGlobal('requestAnimationFrame', () => {
    throw Error('Animation clock is paused');
  });
  document.body.innerHTML = '<div class="scene-host"><div class="mermaid-diagram"></div></div>';
  expect(atlasStageReady()).toBe(false);
  const host = document.querySelector('.mermaid-diagram');
  if (!host) throw Error('Synthetic diagram missing.');
  host.innerHTML = '<svg><text>Asynchronous diagram</text></svg>';
  expect(atlasStageReady()).toBe(true);
});

test('accepts an image only after its bytes complete', () => {
  document.body.innerHTML = '<div class="scene-host"><img alt="Synthetic image"></div>';
  const image = document.querySelector('img');
  if (!image) throw Error('Synthetic image missing.');
  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  expect(atlasStageReady()).toBe(false);
  Object.defineProperty(image, 'complete', { value: true });
  expect(atlasStageReady()).toBe(true);
});

test('waits for archive-backed PDF figures to mount before accepting the stage', () => {
  document.body.innerHTML =
    '<div class="scene-host"><article><figure data-nous-speech="ignore"><figcaption>Caption</figcaption></figure></article></div>';
  try {
    expect(atlasStageReady()).toBe(false);
    const figure = document.querySelector('figure');
    if (!figure) throw new Error('Synthetic PDF figure missing.');
    const image = document.createElement('img');
    image.setAttribute('data-pdf-asset-id', 'synthetic-asset');
    Object.defineProperty(image, 'complete', { value: false, configurable: true });
    figure.append(image);
    expect(atlasStageReady()).toBe(false);
    Object.defineProperty(image, 'complete', { value: true });
    expect(atlasStageReady()).toBe(true);
    image.remove();
    figure.innerHTML = '<span role="img" aria-label="Unavailable">Unavailable</span>';
    expect(atlasStageReady()).toBe(true);
  } finally {
    document.body.replaceChildren();
  }
});
