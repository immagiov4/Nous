import { type ExtractedPdfText, extractPdfText } from './pdfTextExtractor.js';

export const isPdfProjectSourceFile = (file: { mimeType: string; name: string }): boolean =>
  file.mimeType.toLowerCase() === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

export const readProjectSourceText = async (file: {
  data: string;
  mimeType: string;
  name: string;
}): Promise<string> => {
  return (await readProjectSourceMaterial(file)).text;
};

export interface ProjectSourceMaterial {
  pdf?: ExtractedPdfText;
  text: string;
}

export const readProjectSourceMaterial = async (file: {
  data: string;
  mimeType: string;
  name: string;
}): Promise<ProjectSourceMaterial> => {
  if (isPdfProjectSourceFile(file)) {
    const pdf = await extractPdfText(`data:${file.mimeType};base64,${file.data}`);
    return { pdf, text: pdf.text };
  }
  return { text: Buffer.from(file.data, 'base64').toString('utf8') };
};
