// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';

import {
  GENERATED_VISUAL_CONTENT_SECURITY_POLICY,
  supportsGeneratedVisualCapabilities,
} from '../../../utils/visuals/generatedVisualCapabilities.ts';

describe('generated visual capability contract', () => {
  test('accepts inline behavior, styles, and embedded resources', () => {
    const code = `
      <style>.preview { background-image: url(data:image/png;base64,AAAA); }</style>
      <img src="blob:visual-preview">
      <button onclick="this.textContent = 'ok'">Apri</button>
      <script>document.querySelector('button').dataset.ready = 'true';</script>
    `;

    expect(supportsGeneratedVisualCapabilities(code)).toBe(true);
  });

  test.each([
    '<form action="/submit"></form>',
    '<script src="https://example.com/widget.js"></script>',
    '<img src="https://example.com/image.png">',
    '<iframe src="https://example.com"></iframe>',
    '<a href="https://example.com">Apri</a>',
  ])('rejects markup requiring forbidden capabilities: %s', code => {
    expect(supportsGeneratedVisualCapabilities(code)).toBe(false);
  });

  test('denies network, workers, forms, frames, manifests, and objects in the host policy', () => {
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("worker-src 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("manifest-src 'none'");
    expect(GENERATED_VISUAL_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
  });
});
