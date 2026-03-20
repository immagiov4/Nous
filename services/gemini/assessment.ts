import {
  buildDocumentInputContent,
  isPdfFile,
  MODEL_REASONING,
  callOpenRouter,
  parseFunctionCallProfile,
  type ChatMessage,
  type ChatSession,
  type FileData,
  type UserProfile,
} from './shared';
import { getPdfTextSession } from './pdfAssets';

const MAX_ASSESSMENT_SOURCE_CHARS = 6000;

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
    return text.slice(0, MAX_ASSESSMENT_SOURCE_CHARS).trim();
  }

  return excerpt.length < text.length
    ? `${excerpt}\n\n[ESTRATTO ABBREVIATO PER VALUTAZIONE RAPIDA]`
    : excerpt;
};

const buildAssessmentDocumentPrompt = async (
  file: FileData,
  onStatusUpdate?: (status: string) => void
): Promise<AssessmentDocumentContext> => {
  const baseInstruction = 'Ho caricato questo documento. Voglio che tu mi valuti per creare un piano di studio su di esso.';

  if (!isPdfFile(file)) {
    return {
      content: buildDocumentInputContent(file, baseInstruction),
      hasReliableSourceContext: true,
    };
  }

  onStatusUpdate?.('Estrazione testo PDF per valutazione...');

  try {
    const pdfSession = await getPdfTextSession(file);
    const extractedText = pdfSession?.extractedText?.trim() || '';
    if (!extractedText) {
      onStatusUpdate?.('PDF senza testo utile: fallback alla valutazione generica');
      return {
        content: `Documento: ${file.name}\n\n${baseInstruction}\n\nNota: il parser non ha estratto testo utile dal PDF. Non presumere nulla sul contenuto dal titolo o dal nome file. Procedi con una valutazione generica del background e degli obiettivi dell'utente.`,
        hasReliableSourceContext: false,
      };
    }

    const compactText = buildAssessmentExcerpt(extractedText);

    onStatusUpdate?.('PDF analizzato: avvio valutazione...');

    return {
      content: `Documento: ${file.name}

${baseInstruction}

TESTO ESTRATTO DAL DOCUMENTO:
${compactText}`,
      hasReliableSourceContext: true,
    };
  } catch (error) {
    console.warn('[Lumina][Assessment] PDF parsing failed, using generic assessment fallback.', error);
    onStatusUpdate?.('Parse PDF fallito: valutazione generica senza contenuto documento...');
    return {
      content: `Documento: ${file.name}\n\n${baseInstruction}\n\nNota: il parser del PDF e fallito. Non affermare di conoscere il contenuto del documento e non inferirlo dal titolo. Procedi con domande generiche su background, livello e obiettivi dell'utente.`,
      hasReliableSourceContext: false,
    };
  }
};

export const createAssessmentChat = async (
  file: FileData,
  onStatusUpdate?: (status: string) => void
): Promise<ChatSession> => {
  const baseSystemPrompt = `Sei un assistente empatico che deve valutare le conoscenze pregresse dell'utente SUL DOCUMENTO CARICATO.

REGOLE FONDAMENTALI:
1. NON INIZIARE MAI A SPIEGARE O FARE LEZIONI ORA. Il tuo unico scopo è fare domande.
2. Fai domande brevi e dirette per capire il livello (principiante, intermedio, esperto).
3. Se l'utente ti da una risposta molto dettagliata o se hai capito il suo livello PRIMA dei 3 turni previsti, FERMATI.
4. Quando hai abbastanza informazioni per creare un piano di studi, scrivi ESATTAMENTE questo token alla fine della tua risposta: [ASSESSMENT_COMPLETE]

Parla in Italiano.`;

  const assessmentDocument = await buildAssessmentDocumentPrompt(file, onStatusUpdate);
  const systemPrompt = `${baseSystemPrompt}

${assessmentDocument.hasReliableSourceContext
  ? 'Hai un estratto affidabile del documento. Basati solo su quello se ti serve contestualizzare le domande.'
  : 'NON hai contenuto affidabile del documento. Non dire di conoscere il contenuto, non dedurlo dal titolo/nome file, e non fingere di averlo analizzato. Fai solo domande generiche di calibrazione.'}`;

  const history: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: assessmentDocument.content,
    },
    {
      role: 'assistant',
      content: assessmentDocument.hasReliableSourceContext
        ? 'Certamente. Ho letto un estratto affidabile del documento e ti faro qualche breve domanda per calibrare il percorso. Qual e il tuo obiettivo principale con questo testo?'
        : 'Perfetto. Il contenuto del documento non e disponibile in modo affidabile, quindi parto dal tuo background. Hai gia studiato questo argomento oppure stai iniziando da zero?',
    },
  ];

  return {
    sendMessage: async ({ message }) => {
      history.push({ role: 'user', content: message });

      const response = await callOpenRouter({
        model: MODEL_REASONING,
        messages: history,
      });

      history.push({ role: 'assistant', content: response });
      return { text: response };
    },
    getHistory: () => history,
  };
};

export const createLearnAssessmentChat = (language: string): ChatSession<UserProfile> => {
  const systemInstruction = `You are an Expert Curriculum Designer and Profiler.

CRITICAL INSTRUCTION: You MUST speak in ${language}. 
If speaking Italian, use the informal "Tu" (not "Lei").

Tone:
- Professional but sharp. Like a senior engineer or a master craftsman.
- Do NOT use flowery AI greetings. Be direct.
- Ask "Why" often to understand the root motivation.

Goal: Create a HIGH-RESOLUTION profile of the user.

Protocol:
1. If the user gives a generic answer (e.g., "I want to learn code"), ask what for.
2. If the user mentions specific technologies (e.g., "Lua", "Vite", "Supabase"), ASK how they use them or what frustrates them about them.
3. Understand their MENTAL MODEL. Do they like theory first? Or hacking first?

When you have gathered enough information, respond with a JSON object containing the profile:
{
  "topic": "The specific refined topic",
  "experienceLevel": "Beginner|Intermediate|Expert",
  "learningStyle": "Visual|Theoretical|Practical|Auditory",
  "goals": "Specific user goals identified",
  "context": "A DETAILED paragraph containing every specific technical constraint, preference, and background detail"
}

Only return this JSON when you have enough information. Before that, just ask questions.`;

  const history: ChatMessage[] = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: 'Voglio imparare qualcosa di nuovo.' },
    { role: 'assistant', content: 'Cosa vuoi imparare esattamente, e perche?' },
  ];

  return {
    sendMessage: async ({ message }) => {
      history.push({ role: 'user', content: message });

      const response = await callOpenRouter({
        model: MODEL_REASONING,
        messages: history,
      });

      history.push({ role: 'assistant', content: response });

      const profile = parseFunctionCallProfile(response);
      if (profile) {
        return {
          text: response,
          functionCalls: [{ name: 'finalizeProfile', args: profile }],
        };
      }

      return { text: response };
    },
    getHistory: () => history,
  };
};
