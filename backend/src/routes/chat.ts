import { Router, type Request, type Response } from 'express';
import {
  convertToModelMessages,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { CONTEXT_CHAT_MODEL, requireOpenRouterApiKey } from '../config/chatConfig.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

const MAX_CONTEXT_CHARS = 24_000;

const clip = (value: string | undefined, maxChars = MAX_CONTEXT_CHARS) => {
  if (!value) {
    return '';
  }

  return value.length > maxChars ? `${value.slice(0, maxChars).trim()}\n\n[contesto troncato]` : value;
};

const isUiMessageArray = (value: unknown): value is UIMessage[] => {
  return Array.isArray(value);
};

interface ContextChatToolPreferences {
  annotate?: boolean;
  webSearch?: boolean;
}

const webSearchPreferencePrompt = (toolPreferences?: ContextChatToolPreferences) =>
  toolPreferences?.webSearch
    ? "L'utente ha attivato Cerca sul web: dai priorita a grounding, verifica indipendente e informazioni aggiornate quando possono migliorare davvero la risposta."
    : 'Usa il web solo quando servono fonti esterne, fatti aggiornati o verifiche che il materiale locale non puo fornire da solo.';

const contextChatTools = {
  requestAddToNotes: tool({
    description:
      'Propone all\'utente di salvare un chiarimento riusabile come nota sintetica collegata al testo selezionato.',
    inputSchema: jsonSchema<{
      noteDraft: string;
      rationale: string;
      selectedTextDraft: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        noteDraft: {
          type: 'string',
          description: 'Bozza sintetica della nota da salvare, pulita e riusabile.',
        },
        rationale: {
          type: 'string',
          description: 'Spiegazione breve del motivo per cui vale la pena salvarla.',
        },
        selectedTextDraft: {
          type: 'string',
          description:
            'Passaggio di testo rifinito da associare alla nota. Deve essere un chunk piu preciso della selezione originale quando serve.',
        },
      },
      required: ['noteDraft', 'rationale', 'selectedTextDraft'],
    }),
    outputSchema: jsonSchema<{ approved: boolean }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        approved: {
          type: 'boolean',
          description: 'True se l\'utente conferma il salvataggio della nota.',
        },
      },
      required: ['approved'],
    }),
  }),
  saveConversationNote: tool({
    description:
      'Salva una nota persistente nella lezione corrente usando il testo selezionato o una sua versione rifinita. Se esistono annotazioni sovrapposte, puo unirle.',
    inputSchema: jsonSchema<{
      contextAfter?: string;
      contextBefore?: string;
      note: string;
      selectedText: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        contextAfter: {
          type: 'string',
          description: 'Contesto facoltativo dopo il passaggio da annotare.',
        },
        contextBefore: {
          type: 'string',
          description: 'Contesto facoltativo prima del passaggio da annotare.',
        },
        note: {
          type: 'string',
          description: 'Nota sintetica finale da salvare nella lezione.',
        },
        selectedText: {
          type: 'string',
          description: 'Passaggio di testo finale da annotare nella lezione.',
        },
      },
      required: ['note', 'selectedText'],
    }),
    outputSchema: jsonSchema<{
      annotationId?: string;
      error?: string;
      merged: boolean;
      resolvedText?: string;
      saved: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        annotationId: {
          type: 'string',
        },
        error: {
          type: 'string',
        },
        merged: {
          type: 'boolean',
        },
        resolvedText: {
          type: 'string',
        },
        saved: {
          type: 'boolean',
        },
      },
      required: ['merged', 'saved'],
    }),
  }),
  updateConversationNote: tool({
    description:
      'Aggiorna o riscrive una nota gia esistente associata al passaggio corrente, senza concatenarla alla formulazione precedente.',
    inputSchema: jsonSchema<{
      contextAfter?: string;
      contextBefore?: string;
      note: string;
      selectedText: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        contextAfter: {
          type: 'string',
          description: 'Contesto facoltativo dopo il passaggio da annotare.',
        },
        contextBefore: {
          type: 'string',
          description: 'Contesto facoltativo prima del passaggio da annotare.',
        },
        note: {
          type: 'string',
          description: 'Nuova versione della nota da salvare sul passaggio esistente.',
        },
        selectedText: {
          type: 'string',
          description: 'Passaggio di testo finale la cui nota esistente deve essere aggiornata.',
        },
      },
      required: ['note', 'selectedText'],
    }),
    outputSchema: jsonSchema<{
      annotationId?: string;
      error?: string;
      merged: boolean;
      resolvedText?: string;
      saved: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        annotationId: {
          type: 'string',
        },
        error: {
          type: 'string',
        },
        merged: {
          type: 'boolean',
        },
        resolvedText: {
          type: 'string',
        },
        saved: {
          type: 'boolean',
        },
      },
      required: ['merged', 'saved'],
    }),
  }),
} as const;

const buildContextSystemPrompt = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonContent,
  lessonDescription,
  lessonTitle,
  selectedText,
  sourceKind,
  sourceMaterial,
  sourceName,
  toolPreferences,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonContent?: string;
  lessonDescription?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: string;
  sourceMaterial?: string;
  sourceName?: string;
  toolPreferences?: ContextChatToolPreferences;
}) => {
  const selectionContext = [contextBefore, selectedText, contextAfter].filter(Boolean).join(' ');
  const attachedAnnotationBlock = attachedAnnotationText
    ? `PASSAGGIO GIA ANNOTATO:
"""
${attachedAnnotationText}
"""

NOTA GIA ASSOCIATA:
"""
${attachedAnnotationNote || '[nessuna nota salvata finora]'}
"""`
    : 'NOTA GIA ASSOCIATA:\n[nessuna nota collegata a questa selezione]';

  return `Sei Lumina, un assistente didattico integrato nel reader.

Devi rispondere alla conversazione usando come base il contesto seguente:

SELEZIONE EVIDENZIATA:
"""
${selectedText}
"""

CONTESTO IMMEDIATO DELLA SELEZIONE:
"""
${selectionContext || selectedText}
"""

${attachedAnnotationBlock}

TITOLO LEZIONE:
${lessonTitle || 'Lezione corrente'}

DESCRIZIONE LEZIONE:
${lessonDescription || 'Nessuna descrizione disponibile'}

CONTENUTO LEZIONE:
"""
${clip(lessonContent)}
"""

MATERIALE SORGENTE ORIGINALE (${sourceKind || 'non specificato'}${sourceName ? ` - ${sourceName}` : ''}):
"""
${clip(sourceMaterial)}
"""

Regole:
- Rispondi in italiano, salvo richiesta esplicita diversa.
- Considera i messaggi precedenti come follow-up della stessa domanda.
- Usa il markdown solo quando migliora davvero la leggibilita.
- Se il contesto non basta, dillo chiaramente invece di inventare.
- Se il materiale sorgente originale e presente, preferiscilo come base fattuale quando chiarisce meglio della lezione generata.
- Se citi identificatori o simboli, usa i backtick.
- Rimani concreto e orientato alla spiegazione del punto selezionato.
- Hai accesso alla ricerca web tramite OpenRouter. Usala quando servono fonti esterne, informazioni aggiornate o grounding che il materiale locale non puo offrire da solo.
- Quando emerge un chiarimento davvero riusabile durante lo studio, puoi proporre il salvataggio nelle note con il tool \`requestAddToNotes\`.
- Se l'utente ha appena sciolto un dubbio reale, ha corretto un fraintendimento o ha ottenuto una formulazione che sarebbe utile ritrovare rileggendo la lezione, proponi tu in modo proattivo \`requestAddToNotes\` al termine della risposta utile, anche se non te lo chiede esplicitamente.
- Usa \`requestAddToNotes\` solo se la nota sarebbe utile rileggendo la lezione in futuro; non usarlo per dettagli banali o transitori.
- La nota proposta deve essere una sintesi pulita e utile, non il transcript della conversazione.
- Prima chiedi sempre conferma con \`requestAddToNotes\`.
- Se l'utente approva, usa \`saveConversationNote\` con una selezione rifinita e ben formata, preferendo il chunk davvero pertinente al dubbio ma senza allontanarti inutilmente dal passaggio originale.
- Se esiste gia una nota collegata al passaggio e l'utente chiede di cambiarla, correggerla, riscriverla, accorciarla o migliorarla, usa \`updateConversationNote\` invece di \`saveConversationNote\`.
- Se l'utente rifiuta, non insistere e continua normalmente.
- Se la preferenza utente "Annota" e attiva, considera molto probabile che voglia salvare o aggiornare una nota utile su questo passaggio e dai forte priorita ai tool di annotazione quando il chiarimento lo giustifica.
- Se la preferenza utente "Cerca sul web" e attiva, considera la ricerca web una priorita forte ogni volta che la risposta puo beneficiare di fonti esterne, fatti recenti, grounding o verifica indipendente.

Preferenze attive:
- Annota: ${toolPreferences?.annotate ? 'attiva' : 'non attiva'}
- Cerca sul web: ${toolPreferences?.webSearch ? 'attiva' : 'non attiva'}`;
};

router.post('/context', async (req: Request, res: Response) => {
  try {
    const {
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonContent,
      lessonDescription,
      lessonTitle,
      messages,
      selectedText,
      sourceKind,
      sourceMaterial,
      sourceName,
      toolPreferences,
    } = req.body as {
      attachedAnnotationNote?: string;
      attachedAnnotationText?: string;
      contextAfter?: string;
      contextBefore?: string;
      lessonContent?: string;
      lessonDescription?: string;
      lessonTitle?: string;
      messages?: UIMessage[];
      selectedText?: string;
      sourceKind?: string;
      sourceMaterial?: string;
      sourceName?: string;
      toolPreferences?: ContextChatToolPreferences;
    };

    if (!selectedText?.trim()) {
      res.status(400).json({
        success: false,
        error: 'Missing selectedText for contextual chat.',
      });
      return;
    }

    if (!isUiMessageArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing chat messages for contextual chat.',
      });
      return;
    }

    const openrouter = createOpenRouter({
      apiKey: requireOpenRouterApiKey(),
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: contextChatTools }
    );

    const result = streamText({
      model: openrouter.chat(CONTEXT_CHAT_MODEL),
      system: buildContextSystemPrompt({
        attachedAnnotationNote,
        attachedAnnotationText,
        contextAfter,
        contextBefore,
        lessonContent,
        lessonDescription,
        lessonTitle,
        selectedText,
        sourceKind,
        sourceMaterial,
        sourceName,
        toolPreferences,
      }),
      messages: modelMessages,
      tools: contextChatTools,
      providerOptions: {
        openrouter: {
          plugins: [
            {
              id: 'web',
              max_results: 5,
              search_prompt: webSearchPreferencePrompt(toolPreferences),
            },
          ],
          web_search_options: {
            engine: 'native',
            max_results: 5,
            search_prompt: webSearchPreferencePrompt(toolPreferences),
          },
        },
      },
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream(),
    });
  } catch (error) {
    console.error('[Chat Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to stream contextual chat response');
  }
});

export default router;
