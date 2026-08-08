import type { CourseSourceDescriptor } from '../../types.ts';
import { clipText, normalizeLineEndings } from '../../utils/text.ts';
import { formatCourseSourceSetContext } from '../projects/courseSources.ts';
import { decodeTextBase64Preview } from '../projects/projectSource.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import { type FileData, isPdfFile } from './shared.ts';

const MAX_ASSESSMENT_SOURCE_CHARS = 6000;
const MAX_ASSESSMENT_SOURCE_PREVIEW_BYTES = 12_000;

export interface TextAssessmentSource {
  name: string;
  text: string;
}

export interface AssessmentDocumentContext {
  content: string;
  hasReliableSourceContext: boolean;
}

const buildAssessmentExcerpt = (text: string): string => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(part => part.replaceAll(/\s+/g, ' ').trim())
    .filter(Boolean);

  const picked: string[] = [];
  let total = 0;

  for (const paragraph of paragraphs) {
    const nextLength = paragraph.length + (picked.length > 0 ? 2 : 0);
    if (total + nextLength > MAX_ASSESSMENT_SOURCE_CHARS) {
      break;
    }

    picked.push(paragraph);
    total += nextLength;

    if (picked.length >= 8) {
      break;
    }
  }

  const excerpt = picked.join('\n\n').trim();
  if (!excerpt) {
    return clipText(
      text.trim(),
      MAX_ASSESSMENT_SOURCE_CHARS,
      '[ESTRATTO ABBREVIATO PER VALUTAZIONE RAPIDA]'
    );
  }

  return excerpt.length < text.length
    ? `${excerpt}\n\n[ESTRATTO ABBREVIATO PER VALUTAZIONE RAPIDA]`
    : excerpt;
};

const buildAssessmentTextPreview = (file: FileData): string => {
  const preview = normalizeLineEndings(
    decodeTextBase64Preview(file.data, MAX_ASSESSMENT_SOURCE_PREVIEW_BYTES)
  ).trim();

  return clipAssessmentTextPreview(preview);
};

const clipAssessmentTextPreview = (text: string): string => {
  const preview = text.trim();

  if (!preview) {
    return '';
  }

  return clipText(preview, MAX_ASSESSMENT_SOURCE_CHARS, '[ANTEPRIMA ABBREVIATA DELLA SORGENTE]');
};

export const buildAssessmentDocumentContextFromTextSource = (
  source: TextAssessmentSource
): AssessmentDocumentContext => {
  const preview = clipAssessmentTextPreview(normalizeLineEndings(source.text));

  return {
    content: preview
      ? `Sorgente: ${source.name}

Ho caricato questo materiale sorgente. Voglio che tu mi valuti per creare un piano di studio su di esso.

IMPORTANTE: questo messaggio contiene solo il materiale di riferimento e NON conta come risposta di calibrazione dell'utente.

ANTEPRIMA DELLA SORGENTE:
${preview}`
      : `Sorgente: ${source.name}

Ho caricato questo materiale sorgente. Voglio che tu mi valuti per creare un piano di studio su di esso.

IMPORTANTE: questo messaggio contiene solo il materiale di riferimento e NON conta come risposta di calibrazione dell'utente.

Nota: non e stato possibile leggere un'anteprima affidabile della sorgente. Non assumere una struttura ideale del materiale e fai domande generiche di calibrazione.`,
    hasReliableSourceContext: Boolean(preview),
  };
};

export const buildAssessmentDocumentContextFromSourceSet = (
  sources: readonly CourseSourceDescriptor[]
): AssessmentDocumentContext => {
  const usableSources = sources.filter(source => source.status !== 'error');
  const hasReliableSourceContext = usableSources.some(
    source => (source.documentIndex?.chunks.length || 0) > 0
  );
  return {
    content: `Ho caricato ${sources.length} fonti per un unico corso. L'ordine alfabetico serve solo a rendere stabile la lettura: non usarlo come ordine didattico.

IMPORTANTE: gli indici sono mappe strutturali, non dimostrano da soli che un argomento sia trattato bene. Non affermare copertura o qualita basandoti soltanto sui titoli.

FONTI, INDICI E CAMPIONI MIRATI (una riga JSON per fonte):
${formatCourseSourceSetContext(sources)}`,
    hasReliableSourceContext,
  };
};

export const buildAssessmentDocumentPrompt = async (
  file: FileData,
  onStatusUpdate?: (status: string) => void
): Promise<AssessmentDocumentContext> => {
  const baseInstruction =
    'Ho caricato questo materiale sorgente. Voglio che tu mi valuti per creare un piano di studio su di esso.';

  if (!isPdfFile(file)) {
    const preview = buildAssessmentTextPreview(file);
    return {
      content: preview
        ? `Sorgente: ${file.name}

${baseInstruction}

ANTEPRIMA DELLA SORGENTE:
${preview}`
        : `Sorgente: ${file.name}

${baseInstruction}

Nota: non e stato possibile leggere un'anteprima affidabile della sorgente. Non assumere una struttura ideale del materiale e fai domande generiche di calibrazione.`,
      hasReliableSourceContext: Boolean(preview),
    };
  }

  onStatusUpdate?.('Estrazione testo...');

  try {
    const pdfSession = await getPdfTextSession(file);
    const extractedText = pdfSession?.extractedText?.trim() || '';
    if (!extractedText) {
      onStatusUpdate?.('Nessun testo utile: fallback...');
      return {
        content: `Documento: ${file.name}\n\n${baseInstruction}\n\nNota: il parser non ha estratto testo utile dal PDF. Non presumere nulla sul contenuto dal titolo o dal nome file. Procedi con una valutazione generica del background e degli obiettivi dell'utente.`,
        hasReliableSourceContext: false,
      };
    }

    const compactText = buildAssessmentExcerpt(extractedText);

    onStatusUpdate?.('Avvio calibrazione...');

    return {
      content: `Documento: ${file.name}

${baseInstruction}

TESTO ESTRATTO DAL DOCUMENTO:
${compactText}`,
      hasReliableSourceContext: true,
    };
  } catch (error) {
    console.warn(
      '[Nous][Assessment] PDF parsing failed, using generic assessment fallback.',
      error
    );
    onStatusUpdate?.('Lettura fallita: fallback calibrazione...');
    return {
      content: `Documento: ${file.name}\n\n${baseInstruction}\n\nNota: il parser del PDF e fallito. Non affermare di conoscere il contenuto del documento e non inferirlo dal titolo. Procedi con domande generiche su background, livello e obiettivi dell'utente.`,
      hasReliableSourceContext: false,
    };
  }
};
