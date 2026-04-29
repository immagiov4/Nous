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
