import { clipText, normalizeLineEndings } from '../../utils/text.ts';
import { decodeTextBase64Preview } from '../projects/projectSource.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import {
  type ChatMessage,
  type ChatSession,
  callOpenRouter,
  callOpenRouterRaw,
  type FileData,
  isPdfFile,
  MODEL_ASSESSMENT,
  type UserProfile,
} from './shared.ts';

const MAX_ASSESSMENT_SOURCE_CHARS = 6000;
const MAX_ASSESSMENT_SOURCE_PREVIEW_BYTES = 12_000;

interface TextAssessmentSource {
  name: string;
  text: string;
}

interface AssessmentDocumentContext {
  content: ChatMessage['content'];
  hasReliableSourceContext: boolean;
}

const buildAssessmentExcerpt = (text: string): string => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(part => part.replace(/\s+/g, ' ').trim())
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

const buildAssessmentDocumentContextFromTextSource = (
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

const createSeededAssessmentSession = (
  assessmentDocument: AssessmentDocumentContext,
  options?: { seedAssistant?: boolean }
): ChatSession => {
  const baseSystemPrompt = `Sei un assistente empatico che deve valutare le conoscenze pregresse dell'utente SUL DOCUMENTO CARICATO per costruire un piano di studi personalizzato.

REGOLE:
1. Il tuo unico scopo è fare domande di calibrazione. NON spiegare, NON fare lezioni, NON generare il corso, NON creare l'indice delle lezioni, NON riassumere il documento.
2. Fai domande brevi e dirette per capire: livello attuale, obiettivi, difficolta, tipo di materiale che serve e preferenze sul percorso.
3. Il messaggio che contiene la sorgente caricata NON conta come risposta dell'utente.
4. Di norma, dopo circa 3 risposte utili dell'utente dovresti gia avere abbastanza informazioni. Fai piu domande solo se manca davvero un dato ad alto impatto per personalizzare il percorso.
5. Evita domande logistiche o a basso impatto, per esempio ore di studio a settimana, disponibilita sul calendario, orari o dettagli organizzativi simili, a meno che sia l'utente a portarli come vincolo decisivo.
6. Le domande devono concentrarsi su capacita, lacune, familiarita con il materiale, obiettivo finale e preferenze sul tipo di spiegazione o progressione.
7. Quando sei davvero sicuro di avere abbastanza informazioni, scrivi una brevissima conferma e poi ESATTAMENTE il token [ASSESSMENT_COMPLETE] alla fine della tua ultima risposta. La generazione del corso avviene solo dopo un'azione separata dell'app, mai dentro questa chat.

STILE:
- Ogni tua risposta dovrebbe terminare con una domanda concreta, tranne l'ultima con [ASSESSMENT_COMPLETE].
- Se sei incerto su qualcosa, chiedi. Non assumere.
- Sii conciso e diretto, non prolisso.

Parla in Italiano.`;

  const systemPrompt = `${baseSystemPrompt}

${
  assessmentDocument.hasReliableSourceContext
    ? 'Hai contenuto affidabile della sorgente caricata. Basati solo su quello se ti serve contestualizzare le domande e non assumere una struttura ideale del materiale.'
    : 'NON hai contenuto affidabile della sorgente. Non dire di conoscere il contenuto, non dedurlo dal titolo/nome file, e non fingere di averlo analizzato. Fai solo domande generiche di calibrazione.'
}`;

  const history: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: assessmentDocument.content,
    },
  ];

  if (options?.seedAssistant !== false) {
    history.push({
      role: 'assistant',
      content: assessmentDocument.hasReliableSourceContext
        ? 'Perfetto. Ho ricevuto contenuto affidabile dalla sorgente caricata e ti faro qualche breve domanda per calibrare il percorso. Qual e il tuo obiettivo principale con questo materiale?'
        : 'Perfetto. Il contenuto della sorgente non e disponibile in modo affidabile, quindi parto dal tuo background. Hai gia studiato questo argomento oppure stai iniziando da zero?',
    });
  }

  return {
    sendMessage: async ({ message }) => {
      history.push({ role: 'user', content: message });

      const response = await callOpenRouter({
        model: MODEL_ASSESSMENT,
        modelSlot: 'assessment',
        messages: history,
      });

      history.push({ role: 'assistant', content: response });
      return { text: response };
    },
    getHistory: () => history,
  };
};

const buildAssessmentDocumentPrompt = async (
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

export const createAssessmentChat = async (
  file: FileData,
  onStatusUpdate?: (status: string) => void
): Promise<ChatSession> =>
  createSeededAssessmentSession(await buildAssessmentDocumentPrompt(file, onStatusUpdate));

export const createEmbeddedAssessmentChat = async (
  file: FileData,
  onStatusUpdate?: (status: string) => void
): Promise<ChatSession> =>
  createSeededAssessmentSession(await buildAssessmentDocumentPrompt(file, onStatusUpdate), {
    seedAssistant: false,
  });

export const createAssessmentChatFromTextSource = async (
  source: TextAssessmentSource,
  _onStatusUpdate?: (status: string) => void
): Promise<ChatSession> =>
  createSeededAssessmentSession(buildAssessmentDocumentContextFromTextSource(source));

export const createEmbeddedAssessmentChatFromTextSource = async (
  source: TextAssessmentSource,
  _onStatusUpdate?: (status: string) => void
): Promise<ChatSession> =>
  createSeededAssessmentSession(buildAssessmentDocumentContextFromTextSource(source), {
    seedAssistant: false,
  });

const FINALIZE_PROFILE_TOOL = {
  type: 'function',
  function: {
    name: 'finalizeProfile',
    description:
      'Call this tool ONLY when you have gathered enough high-resolution information about the user to build a personalized study path. Do not call it before that. Never narrate the profile in chat — emit it through this tool.',
    parameters: {
      type: 'object',
      required: ['topic', 'experienceLevel', 'learningStyle', 'goals', 'context'],
      properties: {
        topic: {
          type: 'string',
          description: 'The specific refined topic the user wants to learn.',
        },
        experienceLevel: {
          type: 'string',
          enum: ['Beginner', 'Intermediate', 'Expert'],
          description: "User's current level on the topic.",
        },
        learningStyle: {
          type: 'string',
          enum: ['Visual', 'Theoretical', 'Practical', 'Auditory'],
          description: 'Preferred learning style inferred from the conversation.',
        },
        goals: {
          type: 'string',
          description: 'Concrete goals the user expressed.',
        },
        context: {
          type: 'string',
          description:
            'A DETAILED paragraph containing every specific technical constraint, preference, and background detail surfaced during the interview.',
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

const isFinalizeProfileArgs = (
  value: Record<string, unknown>
): value is {
  topic: string;
  experienceLevel: string;
  learningStyle: string;
  goals: string;
  context: string;
} =>
  typeof value.topic === 'string' &&
  typeof value.experienceLevel === 'string' &&
  typeof value.learningStyle === 'string' &&
  typeof value.goals === 'string' &&
  typeof value.context === 'string';

const extractAssistantText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        Boolean(part) &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map(part => part.text)
    .join('\n');
};

const createLearnAssessmentSession = (
  language: string,
  options?: { seedOpeningExchange?: boolean }
): ChatSession<UserProfile> => {
  const systemInstruction = `You are an Expert Curriculum Designer and Profiler.

CRITICAL INSTRUCTION: You MUST speak in ${language}.
If speaking Italian, use the informal "Tu" (not "Lei").

Tone:
- Professional but sharp. Like a senior engineer or a master craftsman.
- Do NOT use flowery AI greetings. Be direct.
- Ask "Why" often to understand the root motivation.

Goal: Create a HIGH-RESOLUTION profile of the user. You are not allowed to write the course, lesson list, syllabus, curriculum, or teaching content in this chat.

Protocol:
1. If the user gives a generic answer (e.g., "I want to learn code"), ask what for.
2. If the user mentions specific technologies (e.g., "Lua", "Vite", "Supabase"), ASK how they use them or what frustrates them about them.
3. Understand their MENTAL MODEL. Do they like theory first? Or hacking first?
4. In most cases, after about 3 useful user answers you should already have enough information to finalize the profile. Ask more only if a high-impact gap remains.
5. Avoid low-impact logistical questions like hours per week, calendar availability, schedules, or classroom-style organization details unless the user explicitly frames them as critical constraints.
6. Prioritize questions about actual skill level, prior exposure, target outcomes, frustrations, and preferred learning style or progression.

How to finalize:
- When (and ONLY when) you have enough information, call the tool "finalizeProfile" with the structured fields. Do NOT write JSON or the profile in chat — emit it strictly through the tool call.
- Until you call the tool, your job is to ask one focused question per turn.
- Never generate the course itself in chat; downstream code will do that after the profile is finalized.`;

  const history: ChatMessage[] = [{ role: 'system', content: systemInstruction }];

  if (options?.seedOpeningExchange !== false) {
    history.push({ role: 'user', content: 'Voglio imparare qualcosa di nuovo.' });
    history.push({ role: 'assistant', content: 'Cosa vuoi imparare esattamente, e perche?' });
  }

  return {
    sendMessage: async ({ message }) => {
      console.info('[Nous][LearnAssessment] sendMessage', {
        preview: message.slice(0, 120),
      });
      history.push({ role: 'user', content: message });

      const raw = await callOpenRouterRaw({
        model: MODEL_ASSESSMENT,
        modelSlot: 'assessment',
        messages: history,
        tools: [FINALIZE_PROFILE_TOOL as unknown as Record<string, unknown>],
      });

      const choiceMessage = raw.choices?.[0]?.message;
      const rawText = extractAssistantText(choiceMessage?.content);
      const toolCall = choiceMessage?.tool_calls?.find(
        call => call.function?.name === 'finalizeProfile'
      );

      console.info('[Nous][LearnAssessment] response', {
        hasToolCall: Boolean(toolCall),
        rawTextLength: rawText.length,
        rawTextPreview: rawText.slice(0, 120),
      });

      if (toolCall) {
        console.info('[Nous][LearnAssessment] tool call raw arguments', {
          arguments: toolCall.function.arguments,
        });
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch (error) {
          console.warn('[Nous][LearnAssessment] Failed to parse finalizeProfile arguments', {
            error,
            arguments: toolCall.function.arguments,
          });
        }

        if (isFinalizeProfileArgs(parsedArgs)) {
          const profile: UserProfile = {
            topic: parsedArgs.topic,
            experienceLevel: parsedArgs.experienceLevel,
            learningStyle: parsedArgs.learningStyle,
            goals: parsedArgs.goals,
            context: parsedArgs.context,
            language,
          };
          history.push({
            role: 'assistant',
            content: rawText || 'Ho tutte le informazioni che mi servono. Costruisco il piano.',
          });
          return {
            text: rawText,
            functionCalls: [{ name: 'finalizeProfile', args: profile }],
          };
        }

        console.warn('[Nous][LearnAssessment] finalizeProfile tool call missing required fields', {
          parsedArgs,
        });
      }

      if (!rawText) {
        console.warn('[Nous][LearnAssessment] Empty assistant response from model', {
          hasToolCall: Boolean(toolCall),
          choice: raw.choices?.[0],
        });
      }

      const text =
        rawText ||
        'Non sono sicuro di aver capito. Puoi darmi un dettaglio in piu su cosa vuoi imparare e perche?';
      history.push({ role: 'assistant', content: text });
      return { text };
    },
    getHistory: () => history,
  };
};

export const createLearnAssessmentChat = (language: string): ChatSession<UserProfile> =>
  createLearnAssessmentSession(language);

export const createEmbeddedLearnAssessmentChat = (language: string): ChatSession<UserProfile> =>
  createLearnAssessmentSession(language, { seedOpeningExchange: false });
