import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { expect, test } from 'vitest';

const buildMinimalPdf = (): Buffer => {
  const header = '%PDF-1.4\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 43 >>\nstream\nBT /F1 12 Tf 30 100 Td (PDF smoke) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
};

test('extracts PDF text in the memory-bounded Node subprocess used by Bun production', async () => {
  const processPath = fileURLToPath(
    new URL('../../src/services/pdfTextFallbackProcess.mjs', import.meta.url)
  );
  const child = spawn('node', ['--max-old-space-size=272', processPath, 'fallback', '10000'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end(buildMinimalPdf());

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  expect(exitCode, stderr).toBe(0);
  expect(deserialize(Buffer.concat(stdout))).toMatchObject({
    pageCount: 1,
    pages: [expect.objectContaining({ pageNumber: 1, text: expect.stringContaining('PDF smoke') })],
  });
});
