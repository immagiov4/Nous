import { getPdfTextSession } from './pdfAssets.ts';
import {
  buildDocumentInputContent,
  callOpenRouter,
  type FileData,
  isPdfFile,
  MODEL_CONTEXT,
  retryWithBackoff,
} from './shared.ts';

const MAX_CONTEXTUAL_ANSWER_SOURCE_CHARS = 32_000;

export const clipPdfSourceText = (text: string, maxChars: number): string => {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n\n[ESTRATTO PDF TRONCATO PER LIMITI DI CONTESTO]`;
};

export const buildPdfReasoningExtractionNotes = (
  pdfSession:
    | {
        parser?: 'pdftotext' | 'pdf-parse';
        pageCount?: number;
      }
    | null
    | undefined
): string => {
  const notes = [
    pdfSession?.parser === 'pdftotext'
      ? '- Il testo e stato estratto con pdftotext in modalita layout-preserving: se trovi blocchi allineati, colonne o valori ripetuti per riga, trattali come possibili tabelle.'
      : pdfSession?.parser === 'pdf-parse'
        ? '- Il testo e stato estratto con pdf-parse: i blocchi tabellari possono risultare piu piatti o riordinati. Se noti pattern tabellari, trattali come tabelle solo quando il testo lo supporta chiaramente.'
        : '- Il testo del PDF puo perdere parte del layout originario: non ignorare blocchi tabellari o confronti solo perche appaiono meno puliti del documento visivo.',
    '- Considera come contenuto sostanziale anche tabelle, blocchi comparativi, matrici, didascalie, legende, assi e label testuali di grafici o schemi quando compaiono nel testo estratto.',
  ];

  if (typeof pdfSession?.pageCount === 'number' && pdfSession.pageCount > 0) {
    notes.unshift(`- Il PDF contiene circa ${pdfSession.pageCount} pagine.`);
  }

  return notes.join('\n');
};

export const buildReasoningContentForFile = async (
  file: FileData,
  prompt: string,
  maxPdfChars: number
) => {
  if (!isPdfFile(file)) {
    return buildDocumentInputContent(file, prompt);
  }

  try {
    const pdfSession = await getPdfTextSession(file);
    const extractedText = pdfSession?.extractedText?.trim() || '';

    if (extractedText) {
      return `Documento: ${file.name}

${prompt}

NOTE DI ESTRAZIONE PDF:
${buildPdfReasoningExtractionNotes(pdfSession)}

TESTO ESTRATTO DAL PDF:
${clipPdfSourceText(extractedText, maxPdfChars)}`;
    }
  } catch (error) {
    console.warn('[Nous][Planning] PDF text extraction failed for reasoning prompt.', error);
  }

  return `Documento: ${file.name}

${prompt}

Nota importante: non e stato possibile estrarre il testo del PDF in modo affidabile.
Non presumere dettagli non supportati e non affermare di aver letto il file se il contenuto non e presente nel prompt.`;
};

interface AskContextualQuestionInput {
  file?: FileData | null;
  selection: string;
  question: string;
  lessonTitle?: string;
  lessonDescription?: string;
  lessonContent?: string;
  contextBefore?: string;
  contextAfter?: string;
}

export const askContextualQuestion = async ({
  file,
  selection,
  question,
  lessonTitle,
  lessonDescription,
  lessonContent,
  contextBefore,
  contextAfter,
}: AskContextualQuestionInput): Promise<string> => {
  const selectionContext = [contextBefore, selection, contextAfter].filter(Boolean).join(' ');
  const basePrompt = `L'utente ha evidenziato questo testo:
"${selection}"

Contesto immediato della selezione:
"${selectionContext || selection}"

Domanda dell'utente:
"${question}"`;

  return retryWithBackoff(async () => {
    const userPromptWithSource = `${basePrompt}

Rispondi in modo conciso e utile basandoti sul documento caricato.
Se la risposta e presente nella fonte originale, citala chiaramente.`;
    const response = await callOpenRouter({
      model: MODEL_CONTEXT,
      modelSlot: 'context',
      messages: file
        ? [
            {
              role: 'user',
              content: await buildReasoningContentForFile(
                file,
                userPromptWithSource,
                MAX_CONTEXTUAL_ANSWER_SOURCE_CHARS
              ),
            },
          ]
        : [
            {
              role: 'user',
              content: `${basePrompt}

Titolo lezione corrente: "${lessonTitle || 'Lezione corrente'}"
Descrizione lezione: "${lessonDescription || 'Nessuna descrizione disponibile'}"

Contenuto della lezione corrente:
${lessonContent || 'Nessun contenuto disponibile.'}

La fonte originale non e allegata. Rispondi usando solo il contesto della lezione corrente.
Se il dettaglio richiesto non e supportato dal testo disponibile, dichiaralo esplicitamente invece di inventare riferimenti.`,
            },
          ],
    });

    return response || 'Non ho potuto generare una risposta.';
  });
};
