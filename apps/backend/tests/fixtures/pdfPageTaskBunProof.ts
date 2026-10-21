import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const { runPdfPageTask } = await import(`${repo}/apps/backend/src/services/pdfPageTask.ts`);
const { buildPdfTextDataUrl } = await import(`${repo}/apps/backend/tests/fixtures/pdfText.ts`);
const data = Buffer.from(buildPdfTextDataUrl().split(',')[1], 'base64');
console.log('runtime', process.versions.bun, process.execPath);
const result = await runPdfPageTask(
  data,
  {
    kind: 'inspect',
    extracted: {
      text: 'Lazy PDF extraction',
      pages: [{ pageNumber: 1, text: 'Lazy PDF extraction' }],
      sourceHash: 'test',
      parser: 'pdf-parse',
      usedFallbackParser: true,
      outline: [],
      outlineOrigin: 'none',
    },
  },
  AbortSignal.timeout(15000)
);
if (result.pageCount !== 1 || result.planned.length !== 0)
  throw new Error('PDF page selection changed.');
console.log('result', JSON.stringify(result));
