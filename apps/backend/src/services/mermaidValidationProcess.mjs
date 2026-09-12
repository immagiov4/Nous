import { text } from 'node:stream/consumers';
import { JSDOM } from 'jsdom';

// Mermaid's sanitizer needs a DOM even when only parsing class diagrams.
const dom = new JSDOM('');
globalThis.window = dom.window;
try {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ securityLevel: 'strict', startOnLoad: false });
  const code = await text(process.stdin);
  try {
    await mermaid.parse(code);
    process.stdout.write('valid');
  } catch (error) {
    // Jison syntax errors carry the parser's location and expected tokens.
    if (!error || typeof error !== 'object' || !('hash' in error)) throw error;
    process.stdout.write('invalid');
  }
} finally {
  dom.window.close();
}
