import {
  buildDocumentInputContent,
  MODEL_FLASH,
  MODEL_REASONING,
  callOpenRouter,
  parseFunctionCallProfile,
  type ChatMessage,
  type ChatSession,
  type FileData,
  type UserProfile,
} from './shared';

export const createAssessmentChat = (file: FileData): ChatSession => {
  const systemPrompt = `Sei un assistente empatico che deve valutare le conoscenze pregresse dell'utente SUL DOCUMENTO CARICATO.

REGOLE FONDAMENTALI:
1. NON INIZIARE MAI A SPIEGARE O FARE LEZIONI ORA. Il tuo unico scopo è fare domande.
2. Fai domande brevi e dirette per capire il livello (principiante, intermedio, esperto).
3. Se l'utente ti da una risposta molto dettagliata o se hai capito il suo livello PRIMA dei 3 turni previsti, FERMATI.
4. Quando hai abbastanza informazioni per creare un piano di studi, scrivi ESATTAMENTE questo token alla fine della tua risposta: [ASSESSMENT_COMPLETE]

Parla in Italiano.`;

  const history: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: buildDocumentInputContent(
        file,
        'Ho caricato questo documento. Voglio che tu mi valuti per creare un piano di studio su di esso.'
      ),
    },
    {
      role: 'assistant',
      content:
        'Certamente. Ho analizzato il documento. Ti faro qualche breve domanda per capire come strutturare il corso. Qual e il tuo obiettivo principale con questo testo?',
    },
  ];

  return {
    sendMessage: async ({ message }) => {
      history.push({ role: 'user', content: message });

      const response = await callOpenRouter({
        model: MODEL_FLASH,
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
