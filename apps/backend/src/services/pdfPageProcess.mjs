import { PDFParse } from 'pdf-parse';
import { inspectPdfTextPages, PDF_PAGE_LOAD_OPTIONS } from './pdfPageProcessing.mjs';

// The parent owns the deadline and can terminate synchronous PDF.js work.
process.once('message', async ({ bytes, task }) => {
  const parser = new PDFParse({ data: Buffer.from(bytes, 'base64'), ...PDF_PAGE_LOAD_OPTIONS });
  let response;
  try {
    if (task.kind === 'inspect')
      response = { result: await inspectPdfTextPages(parser, task.extracted) };
    else {
      const rendered = await parser.getScreenshot({
        partial: [task.pageNumber],
        desiredWidth: task.width,
        imageBuffer: false,
      });
      const page = rendered.pages[0];
      if (!page) throw new Error('PDF page renderer returned no page.');
      response = { result: { dataUrl: page.dataUrl, width: page.width, height: page.height } };
    }
  } catch {
    response = { error: true };
  } finally {
    await parser.destroy();
  }
  process.send(response, () => process.exit(0));
});
