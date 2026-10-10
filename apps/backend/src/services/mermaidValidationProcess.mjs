import { text } from 'node:stream/consumers';
import { JSDOM } from 'jsdom';

// Mermaid's sanitizer needs a DOM even when only parsing class diagrams.
const dom = new JSDOM('');
globalThis.window = dom.window;
try {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ securityLevel: 'strict', startOnLoad: false });
  const code = await text(process.stdin);
  if (process.argv.includes('--classify-batch')) {
    const codes = JSON.parse(code);
    if (!Array.isArray(codes) || !codes.every(input => typeof input === 'string')) {
      throw new Error('Mermaid classification requires an array of strings.');
    }
    const results = [];
    for (const input of codes) {
      const parsed = await mermaid.parse(input, { suppressErrors: true });
      results.push(Boolean(parsed));
    }
    process.stdout.write(JSON.stringify(results));
  } else if (process.argv.includes('--allow-non-diagram')) {
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    process.stdout.write(parsed ? 'valid' : 'invalid');
  } else {
    try {
      await mermaid.parse(code);
      process.stdout.write('valid');
    } catch (error) {
      // Jison syntax errors carry the parser's location and expected tokens.
      if (!error || typeof error !== 'object' || !('hash' in error)) throw error;
      process.stdout.write('invalid');
    }
  }
} finally {
  dom.window.close();
}
