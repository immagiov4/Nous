import { buildReasoningContentForFile } from './pdfReasoning.ts';
import { callOpenRouter, type FileData, MODEL_CONTEXT, retryWithBackoff } from './shared.ts';

const MAX_CONTEXTUAL_ANSWER_SOURCE_CHARS = 32_000;

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
  const lessonPrompt = `LEZIONE CORRENTE
Titolo: "${lessonTitle || 'Lezione corrente'}"
Descrizione: "${lessonDescription || 'Nessuna descrizione disponibile'}"

Contenuto completo:
${lessonContent || 'Nessun contenuto disponibile.'}

PASSAGGIO SELEZIONATO DALL'UTENTE
"${selection}"

Contesto immediato del passaggio:
"${selectionContext || selection}"

Domanda dell'utente:
"${question}"

Usa l'intera lezione per interpretare il passaggio selezionato. Mantieni il passaggio come focus esplicito della risposta e non trattarlo come testo isolato.`;

  return retryWithBackoff(async () => {
    const userPromptWithSource = `${lessonPrompt}

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
              content: `${lessonPrompt}

La fonte originale non e allegata. Rispondi usando solo il contesto della lezione corrente.
Se il dettaglio richiesto non e supportato dal testo disponibile, dichiaralo esplicitamente invece di inventare riferimenti.`,
            },
          ],
    });

    return response || 'Non ho potuto generare una risposta.';
  });
};
