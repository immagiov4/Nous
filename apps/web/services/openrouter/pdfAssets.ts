import { assessPdfTextQuality, type PdfTextQualityReport } from '@shared/pdfTextQuality';
import type { PdfImageAsset, PdfTextPage, SourceOutlineNode } from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { type FileData, fileToDataUrl, getBackendUrl, isPdfFile } from './shared.ts';

const PDF_TEXT_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const PDF_ASSET_CACHE_VERSION = 'resolution-metadata-v3';

interface BackendPdfTextResponse {
  success: boolean;
  text?: string;
  pages?: PdfTextPage[];
  textLength?: number;
  parser?: 'pdftotext' | 'pdf-parse';
  sourceHash?: string;
  pageCount?: number;
  error?: string;
  outline?: SourceOutlineNode[];
  outlineOrigin?: 'deterministic' | 'native' | 'none';
}

export interface PdfAssetSession {
  images: PdfImageAsset[];
  extractedText: string;
  pages: PdfTextPage[];
  pageCount?: number;
  parser?: 'pdftotext' | 'pdf-parse';
  parsedAt: string;
  sourceHash?: string;
  outline: SourceOutlineNode[];
  outlineOrigin: 'deterministic' | 'native' | 'none';
}

export type { PdfTextQualityReport } from '@shared/pdfTextQuality';

class PdfTextQualityError extends Error {
  readonly code = 'PDF_TEXT_QUALITY_INSUFFICIENT';
  readonly report: PdfTextQualityReport;

  constructor(fileName: string, report: PdfTextQualityReport) {
    super(
      `Questo PDF non contiene abbastanza testo selezionabile per generare un percorso affidabile. Se è un libro scannerizzato, serve una versione con OCR o testo estraibile.`
    );
    this.name = 'PdfTextQualityError';
    this.report = report;
    console.warn('[Nous][PDF] Insufficient text quality', {
      fileName,
      report,
    });
  }
}

const logPdfAssetDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Nous][PDF] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

export const validatePdfTextSource = async (
  file: FileData
): Promise<PdfTextQualityReport | null> => {
  if (!isPdfFile(file)) {
    return null;
  }

  const session = await getPdfTextSession(file);
  if (!session) {
    return null;
  }

  const report = assessPdfTextQuality(session);
  if (report.status !== 'ok') {
    throw new PdfTextQualityError(file.name, report);
  }

  return report;
};

const getPdfCacheKey = (file: FileData): string =>
  `${PDF_ASSET_CACHE_VERSION}:${file.name}:${file.data.length}:${file.data.slice(0, 96)}:all-pages`;

const extractPdfTextViaBackend = async (file: FileData): Promise<PdfAssetSession> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/pdf/extract-text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileData: fileToDataUrl(file),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PDF text backend error: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as BackendPdfTextResponse;
  if (!payload.success) {
    throw new Error(payload.error || 'Unknown PDF text backend error');
  }

  const extractedText = typeof payload.text === 'string' ? payload.text : '';
  let outlineSequence = 0;
  const normalizeOutline = (nodes: SourceOutlineNode[], level = 1): SourceOutlineNode[] =>
    nodes
      .filter(node => Boolean(node) && typeof node.title === 'string' && node.title.trim())
      .map(node => {
        outlineSequence += 1;
        const outlineId = `${file.sourceId || 'source'}:outline:pdf-${outlineSequence}`;
        return {
          children: normalizeOutline(Array.isArray(node.children) ? node.children : [], level + 1),
          id: outlineId,
          level,
          page: Number.isInteger(node.page) && (node.page || 0) > 0 ? node.page : undefined,
          title: node.title.trim(),
        };
      });
  const outline = normalizeOutline(Array.isArray(payload.outline) ? payload.outline : []);
  const pages = Array.isArray(payload.pages)
    ? payload.pages
        .filter(
          (page): page is PdfTextPage =>
            Boolean(page) && Number.isInteger(page.pageNumber) && typeof page.text === 'string'
        )
        .map(page => ({
          pageNumber: page.pageNumber,
          text: page.text,
        }))
    : [];
  logPdfAssetDebug('Backend text extraction result', {
    filename: file.name,
    parser: payload.parser,
    pageCount: payload.pageCount,
    pageTextCount: pages.length,
    textLength: extractedText.length,
    sourceHash: payload.sourceHash,
    preview: extractedText.slice(0, 400),
  });

  return {
    images: [],
    extractedText,
    pages,
    pageCount: payload.pageCount,
    parser: payload.parser,
    parsedAt: timestampIso(),
    sourceHash: payload.sourceHash,
    outline,
    outlineOrigin: outline.length > 0 ? payload.outlineOrigin || 'deterministic' : 'none',
  };
};

export const getPdfTextSession = async (file: FileData): Promise<PdfAssetSession | null> => {
  if (!isPdfFile(file)) {
    return null;
  }

  const cacheKey = getPdfCacheKey(file);
  const cached = PDF_TEXT_PARSE_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const nextPromise = extractPdfTextViaBackend(file).catch(error => {
    PDF_TEXT_PARSE_CACHE.delete(cacheKey);
    throw error;
  });

  PDF_TEXT_PARSE_CACHE.set(cacheKey, nextPromise);
  return nextPromise;
};
