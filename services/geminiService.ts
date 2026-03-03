import { FileData, LearningPlan, Message, LearningSection, VoiceName } from "../types";
import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from "../constants";

// OpenRouter API Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Model configuration - can be changed to any OpenRouter-supported model
export const MODEL_REASONING = 'google/gemini-2.0-flash-exp:free';
export const MODEL_FAST = 'google/gemini-2.0-flash-exp:free';
export const MODEL_PRO = 'google/gemini-2.0-pro-exp';

// Headers for OpenRouter API
const getHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
  'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  'X-Title': 'Lumina Deep Reader'
});

/**
 * Utility to retry operations with exponential backoff.
 */
async function retryWithBackoff<T>(operation: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    if (retries <= 0) throw error;
    
    const status = error?.status || 0;
    const isRetryable = status >= 500 || status === 429 || error?.message?.includes('rate');
    
    if (isRetryable) {
      console.warn(`API Error ${status}. Retrying in ${delay}ms... (${retries} left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(operation, retries - 1, delay * 2);
    }
    
    throw error;
  }
}

/**
 * Convert file data to base64 data URL for OpenRouter
 */
const fileToDataUrl = (file: FileData): string => {
  return `data:${file.mimeType};base64,${file.data}`;
};

/**
 * OpenRouter chat completion API call
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{type: string; text?: string; image_url?: {url: string}}>;
}

interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'json_schema'; json_schema?: any };
  tools?: any[];
}

const callOpenRouter = async <T = string>(options: ChatCompletionOptions): Promise<T> => {
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 8192,
      response_format: options.response_format,
      tools: options.tools
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  
  return content as T;
};

/**
 * Creates a chat session for the initial knowledge assessment.
 */
export const createAssessmentChat = (file: FileData) => {
  const systemPrompt = `Sei un assistente empatico che deve valutare le conoscenze pregresse dell'utente SUL DOCUMENTO CARICATO.

REGOLE FONDAMENTALI:
1. NON INIZIARE MAI A SPIEGARE O FARE LEZIONI ORA. Il tuo unico scopo è fare domande.
2. Fai domande brevi e dirette per capire il livello (principiante, intermedio, esperto).
3. Se l'utente ti dà una risposta molto dettagliata o se hai capito il suo livello PRIMA dei 3 turni previsti, FERMATI.
4. Quando hai abbastanza informazioni per creare un piano di studi, scrivi ESATTAMENTE questo token alla fine della tua risposta: [ASSESSMENT_COMPLETE]

Parla in Italiano.`;

  const initialMessages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
        { type: 'text', text: "Ho caricato questo documento. Voglio che tu mi valuti per creare un piano di studio su di esso." }
      ]
    },
    {
      role: 'assistant',
      content: "Certamente. Ho analizzato il documento. Ti farò qualche breve domanda per capire come strutturare il corso. Qual è il tuo obiettivo principale con questo testo?"
    }
  ];

  let history: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages
  ];

  return {
      sendMessage: async (params: { message: string }): Promise<{ text: string; functionCalls?: any[] }> => {
        history.push({ role: 'user', content: params.message });
        
        const response = await callOpenRouter({
          model: MODEL_FAST,
          messages: history
        });
  
        history.push({ role: 'assistant', content: response });
        
        // Try to parse as JSON for function call detection (Learn Mode)
        try {
          const parsed = JSON.parse(response);
          if (parsed.topic && parsed.experienceLevel) {
            return {
              text: response,
              functionCalls: [{ name: 'finalizeProfile', args: parsed }]
            };
          }
        } catch {
          // Not JSON, return as text
        }
        
        return { text: response };
      },
      getHistory: () => history
    };
  };

/**
 * Generates the Structured Learning Plan.
 */
export const generateLearningPlan = async (
  file: FileData,
  assessmentHistory: Message[]
): Promise<LearningPlan> => {
  
  const assessmentSummary = assessmentHistory
    .map(m => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n');

  const prompt = `Analizza il documento allegato.
Ecco il contesto dell'utente (Assessment):
${assessmentSummary}

Crea un piano di studi dettagliato.
- Se l'utente è principiante, aggiungi capitoli 'prerequisite' corposi.
- Dividi il paper in sezioni logiche ('core').
- Aggiungi un capitolo finale di sintesi ('summary').
- Assicurati che i titoli siano descrittivi.
- La descrizione deve spiegare COSA si imparerà in quella sezione.

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "title": "Titolo generale del percorso",
  "summary": "Breve panoramica motivazionale",
  "sections": [
    {
      "id": "unique-id",
      "title": "Titolo sezione",
      "description": "Cosa si impara",
      "type": "prerequisite|core|summary",
      "isCompleted": false
    }
  ]
}`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_PRO,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION_PLANNER },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      response_format: { type: 'json_object' }
    });

    if (!response) throw new Error("No plan generated");
    
    try {
      return JSON.parse(response) as LearningPlan;
    } catch (e) {
      console.error("JSON Parse Error", e);
      throw new Error("Failed to parse learning plan.");
    }
  });
};

/**
 * Creates metadata for a NEW sub-chapter based on user selection.
 */
export const createSubChapterMetadata = async (
  file: FileData,
  parentSection: LearningSection,
  selection: string,
  userInstructions: string
): Promise<LearningSection> => {
  
  const prompt = `L'utente sta studiando il capitolo: "${parentSection.title}".
Descrizione capitolo: "${parentSection.description}".

L'utente ha evidenziato questo testo specifico: "${selection}".

Istruzioni dell'utente per l'approfondimento: "${userInstructions || "Approfondisci questo concetto in dettaglio"}".

Il tuo compito è creare il METADATA per una nuova lezione (sotto-capitolo) dedicata esclusivamente a questo punto evidenziato.
Questa lezione deve essere un "Deep Dive".

Rispondi SOLO con un oggetto JSON:
{
  "title": "Titolo accattivante per la nuova lezione",
  "description": "Cosa si imparerà in questo approfondimento"
}`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FAST,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      response_format: { type: 'json_object' }
    });

    if (!response) throw new Error("Failed to generate sub-chapter metadata");
    
    const json = JSON.parse(response);

    return {
      id: crypto.randomUUID(),
      title: json.title,
      description: json.description,
      isCompleted: false,
      type: 'deep-dive',
      parentId: parentSection.id,
      content: undefined,
      quiz: undefined
    };
  });
};

/**
 * Generates the detailed content for a specific section.
 */
export const generateSectionContent = async (
  file: FileData,
  sectionTitle: string,
  sectionDescription: string,
  previousContext: string,
  onStatusUpdate?: (status: string) => void
): Promise<{ content: string; quiz: any[] }> => {
  
  // STEP 1: DRAFTING
  if (onStatusUpdate) onStatusUpdate("Analisi strutturale e bozza iniziale...");
  
  const draftPrompt = `Sei il Professor Lumina.
Obiettivo: Scrivere una BOZZA strutturale per la lezione: "${sectionTitle}".
Descrizione: "${sectionDescription}".

Contesto precedente: ${previousContext || "Inizio percorso"}.

Compito:
Scrivi una lezione accademica solida ma concisa. 
Definisci i concetti chiave che devono essere trattati.
Crea la struttura logica (Introduzione, Concetti Chiave, Analisi, Conclusione).
Usa titoli chiari.`;

  const draftResponse = await retryWithBackoff(async () => {
    return await callOpenRouter({
      model: MODEL_FAST,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: draftPrompt }
          ]
        }
      ]
    });
  });

  const draftText = draftResponse || "";

  // STEP 2: EXPANDING
  if (onStatusUpdate) onStatusUpdate("Espansione e iniezione dettagli tecnici...");

  const refinementPrompt = `Agisci come un Ricercatore Senior e Editor Tecnico.

Hai ricevuto la seguente BOZZA di lezione (generata sopra):
--- INIZIO BOZZA ---
${draftText}
--- FINE BOZZA ---

IL TUO COMPITO (ESPANSIONE, NON RISCRITTURA):
1. Mantieni RIGOROSAMENTE la struttura, i titoli e il flusso della bozza. NON cambiare l'ordine degli argomenti.
2. Il tuo unico scopo è ESPANDERE i paragrafi esistenti iniettando dettagli tecnici precisi dal DOCUMENTO SORGENTE.

AZIONI DI ESPANSIONE:
- Dove la bozza menziona un concetto matematico, INSERISCI la formula esatta in LaTeX (block mode $$...$$) trovata nel testo originale.
- Dove la bozza menziona un algoritmo o codice, INSERISCI lo snippet di codice o pseudocodice.
- Dove la bozza è generica ("L'autore afferma..."), AGGIUNGI la citazione precisa o il dato numerico.

Risultato finale: Una versione densa, tecnica e ricca della bozza originale, ma con la stessa struttura.

Formatta in Markdown ricco.

AL TERMINE DELLA LEZIONE ESPANSA:
Genera un separatore "---QUIZ---" seguito da un array JSON di 3 domande a risposta multipla basate ESCLUSIVAMENTE sui dettagli specifici che hai appena inserito.
Formato JSON Quiz: [{ "question": "...", "options": ["A", "B", "C"], "correctIndex": 0 }]`;

  const finalResponse = await retryWithBackoff(async () => {
    return await callOpenRouter({
      model: MODEL_PRO,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION_TEACHER },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: refinementPrompt }
          ]
        }
      ]
    });
  });

  const rawText = finalResponse || "";
  const [content, quizPart] = rawText.split("---QUIZ---");
  
  let quiz = [];
  try {
    if (quizPart) {
      const cleanJsonStr = quizPart.replace(/```json/g, '').replace(/```/g, '').trim();
      quiz = JSON.parse(cleanJsonStr);
    }
  } catch (e) {
    console.warn("Quiz parsing failed", e);
  }

  return { content: content.trim(), quiz };
};

/**
 * Handles contextual questions.
 */
export const askContextualQuestion = async (
  file: FileData,
  selection: string,
  question: string
): Promise<string> => {
  const prompt = `L'utente ha evidenziato questo testo: "${selection}"
Domanda dell'utente: "${question}"

Rispondi in modo conciso e utile basandoti sul documento caricato.
Se la risposta è nel paper, cita il paper.`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FAST,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt }
          ]
        }
      ]
    });

    return response || "Non ho potuto generare una risposta.";
  });
};

/**
 * Generates audio speech from text.
 * Note: OpenRouter doesn't support TTS directly. This would need a separate TTS service.
 * For now, we'll throw an error indicating TTS is not available.
 */
export const generateSpeech = async (text: string, voice: VoiceName): Promise<ArrayBuffer> => {
  // TTS is not supported via OpenRouter
  // You would need to integrate a separate TTS service (e.g., ElevenLabs, OpenAI TTS, etc.)
  throw new Error("Text-to-speech is not currently supported with OpenRouter. Please integrate a separate TTS provider.");
};

// --- LEARN MODE (NO ATTACHMENTS) ---

const cleanJson = (text: string): string => {
    let clean = text.replace(/```json\n?|```/g, '').trim();
    const firstBracket = clean.indexOf('[');
    const firstBrace = clean.indexOf('{');
    const start = (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) ? firstBracket : firstBrace;
    
    if (start !== -1) clean = clean.substring(start);
    
    const lastBracket = clean.lastIndexOf(']');
    const lastBrace = clean.lastIndexOf('}');
    const end = (lastBracket !== -1 && (lastBrace === -1 || lastBracket > lastBrace)) ? lastBracket : lastBrace;
    
    if (end !== -1) clean = clean.substring(0, end + 1);
    
    clean = clean.replace(/\\u(?![0-9a-fA-F]{4})/g, 'u');
    clean = clean.replace(/\\(?![bfnrtu"\\\/])/g, '');
    
    return clean;
};

const sanitizeTitle = (title: string): string => {
    if (!title) return "Untitled Lesson";
    let clean = title
        .replace(/^(Output|Rule|Strict|Instruction|Task|Topic).*?:/i, '')
        .replace(/["*_]/g, '')
        .trim();
    
    const words = clean.split(' ');
    if (words.length > 10) {
        return words.slice(0, 10).join(' ') + '...';
    }
    return clean;
};

export const createLearnAssessmentChat = (language: string) => {
  const SYSTEM_INSTRUCTION_INTERVIEW = `You are an Expert Curriculum Designer and Profiler.

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

  let history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_INSTRUCTION_INTERVIEW },
    { role: 'user', content: "Voglio imparare qualcosa di nuovo." },
    { role: 'assistant', content: "Cosa vuoi imparare esattamente, e perché?" }
  ];

  return {
      sendMessage: async (params: { message: string }): Promise<{ text: string; functionCalls?: any[] }> => {
        history.push({ role: 'user', content: params.message });
        
        const response = await callOpenRouter({
          model: MODEL_REASONING,
          messages: history
        });
  
        history.push({ role: 'assistant', content: response });
        
        // Try to parse as JSON for function call detection (Learn Mode profile finalization)
        try {
          const parsed = JSON.parse(response);
          if (parsed.topic && parsed.experienceLevel) {
            return {
              text: response,
              functionCalls: [{ name: 'finalizeProfile', args: parsed }]
            };
          }
        } catch {
          // Not JSON, return as text
        }
        
        return { text: response };
      },
      getHistory: () => history
    };
  };

async function runArchitect(profile: any): Promise<any[]> {
    const topic = profile?.topic || "General Knowledge";
    const level = profile?.experienceLevel || "Intermediate";
    const context = profile?.context || "General Learner";
    const lang = profile?.language || "Italian";

    const prompt = `ROLE: Curriculum Architect & Researcher.
TOPIC: ${topic} (${level})
CONTEXT: ${context}
LANG: ${lang}

TASK: Design a comprehensive 4-7 Module curriculum. Each module MUST contain 3-5 specific lessons.
OUTPUT: JSON Only.

RULES:
- Titles MUST be short (max 6 words).
- No "Introduction to..." boilerplate.
- Structure logically: Foundations -> Core Mechanics -> Advanced Patterns -> Mastery.
- **Granularity**: Each lesson must focus on ONE core concept.
- **ContextPrompt**: For each lesson, provide a specific instruction for the writer (mention metaphors, traps, or specific student needs).
- **Depth**: Dig deep. Find high-value concepts relevant to the user's specific context.

Return JSON with this structure:
{
  "modules": [
    {
      "title": "Module Title",
      "description": "Module description",
      "lessons": [
        {
          "title": "Lesson Title",
          "description": "Lesson description",
          "contextPrompt": "Specific instruction for the writer"
        }
      ]
    }
  ]
}`;

    const response = await callOpenRouter({
        model: MODEL_REASONING,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
    });

    const data = JSON.parse(cleanJson(response || "{}"));
    return data.modules || [];
}

async function runCritic(modules: any[]): Promise<boolean> {
    if (!modules || modules.length === 0) return false;

    const checkPrompt = `Analyze these module titles.
1. Are they coherent?
2. Do they look like raw prompts (e.g. "Output strictly")?
3. Are they too long?

Return TRUE only if they are high quality titles.

Titles: ${JSON.stringify(modules.map(m => m.title))}

Return JSON: { "valid": true } or { "valid": false }`;

    const response = await callOpenRouter({
        model: MODEL_FAST,
        messages: [{ role: 'user', content: checkPrompt }],
        response_format: { type: 'json_object' }
    });

    const res = JSON.parse(cleanJson(response || "{}"));
    return res.valid === true;
}

export const generateFullCurriculum = async (
    profile: any, 
    onStatusUpdate: (msg: string) => void,
    onStructureUpdate: (items: any[]) => void,
    onRevisionStart: () => void
): Promise<any[]> => {
    let modulesRaw: any[] = [];
    let attempts = 0;
    let validSkeleton = false;

    while (!validSkeleton && attempts < 3) {
        attempts++;
        onStatusUpdate(attempts > 1 ? `Architect is redesigning (Attempt ${attempts})...` : "Architect is designing the blueprint...");
        
        try {
            modulesRaw = await runArchitect(profile);
            validSkeleton = await runCritic(modulesRaw);
        } catch (e) {
            console.error("Architect failed", e);
        }
    }

    let currentStructure: any[] = modulesRaw.map((m: any, idx: number) => ({
        id: `mod-${idx}`,
        title: sanitizeTitle(m.title),
        description: m.description,
        type: 'module',
        status: 'ready',
        children: m.lessons?.map((l: any, lIdx: number) => ({
            id: `mod-${idx}-lesson-${lIdx}`,
            title: sanitizeTitle(l.title),
            description: l.description,
            contextPrompt: l.contextPrompt,
            type: 'lesson',
            status: 'pending'
        })) || []
    }));

    onStructureUpdate([...currentStructure]);
    return currentStructure;
};

const getCurriculumContext = (syllabus: any[], currentModuleId: string, currentLessonId: string) => {
    let pastTopics: string[] = [];
    let futureTopics: string[] = [];
    let foundCurrent = false;
    let currentLessonDescription = "";

    syllabus.forEach(mod => {
        if (!mod.children) return;
        
        const isCurrentModule = mod.id === currentModuleId;
        
        if (isCurrentModule) {
            mod.children.forEach((lesson: any) => {
                if (lesson.id === currentLessonId) {
                    foundCurrent = true;
                    currentLessonDescription = lesson.description;
                } else if (!foundCurrent) {
                    pastTopics.push(`(Same Module) ${lesson.title}: ${lesson.description}`);
                } else {
                    futureTopics.push(`(Same Module) ${lesson.title}`);
                }
            });
        } else if (!foundCurrent) {
            pastTopics.push(`MODULE: ${mod.title}`);
        } else {
            futureTopics.push(`MODULE: ${mod.title}`);
        }
    });

    return {
        pastContext: pastTopics.join("\n"),
        futureContext: futureTopics.join("\n"),
        currentLessonDescription
    };
};

export const generateLearnLessonContent = async (
  lessonTitle: string,
  moduleTitle: string,
  currentModuleId: string,
  currentLessonId: string,
  contextPrompt: string | undefined,
  profile: any,
  syllabus: any[],
  onStatusUpdate: (status: string) => void
): Promise<string> => {
  const { pastContext, futureContext, currentLessonDescription } = getCurriculumContext(syllabus, currentModuleId, currentLessonId);

  onStatusUpdate("Consulting the archives...");
  
  const studentContext = profile?.context || "General Learner";
  const studentLevel = profile?.experienceLevel || "Intermediate";
  const studentLang = profile?.language || "Italian";

  const draftPrompt = `ROLE: World-Class Technical Author & Professor.
TONE: Authoritative, "No BS", Charismatic, Narrative-driven.

LESSON: "${lessonTitle}" (Module: "${moduleTitle}")
DESCRIPTION: "${currentLessonDescription}"

STUDENT: ${studentContext}
LEVEL: ${studentLevel}
LANG: ${studentLang}

TECHNICAL CONTEXT: "${contextPrompt || "Explain this clearly."}"

CRITICAL WRITING RULES:
1. **The Bridge**: If this lesson covers distinct layers (e.g., UI vs Database), you MUST explain the connection. 
2. **The Hook**: Start with a paradox or a bold statement. Never say "Welcome".
3. **Visuals**: DO NOT use Mermaid diagrams or any other diagramming language. We cannot render them. Use standard markdown tables, lists, or ASCII art if visual representation is needed.
4. **Code**: Use realistic, detailed examples.
5. **Depth**: Write a comprehensive, deep-dive lesson. Do not rush. Expand on concepts thoroughly, explain the 'Why' and 'How' in detail, and provide substantial content.
6. **Structure**: 
   - The Concept (The Mental Model)
   - The Architecture (The 'Why')
   - The Implementation (The 'How')
   - The Trap (What goes wrong)

FORMAT: Markdown.`;

  const draftText = await retryWithBackoff(async () => {
    return await callOpenRouter({
        model: MODEL_REASONING,
        messages: [{ role: 'user', content: draftPrompt }]
    });
  }, 2, 1000);

  onStatusUpdate("Refining the narrative flow...");
  
  const critiquePrompt = `ROLE: Senior Editor at a prestigious technical publisher.
TASK: Polish this lesson.

Directives:
1. **Check Transitions**: Does the text jump wildly between topics? If so, insert a smooth transition sentence explaining the link.
2. **Tone Check**: Ensure it sounds like an expert speaking to a peer/apprentice, not a wiki page.
3. **Sanitize**: Remove "Here is the lesson" or meta-talk.
4. **Format**: Ensure valid Markdown. DO NOT use Mermaid diagrams.
5. **Depth**: Ensure the lesson feels comprehensive and not rushed. Expand on sections that feel too brief.

DRAFT TEXT:
${draftText}`;

  let finalText = await retryWithBackoff(async () => {
    return await callOpenRouter({
        model: MODEL_REASONING,
        messages: [{ role: 'user', content: critiquePrompt }]
    });
  }, 1, 1000);

  finalText = finalText.replace(/^Here is.*?:\s*/i, '')
                       .replace(/^Certamente.*?:\s*/i, '')
                       .replace(/```json/g, '')
                       .trim();

  return finalText;
};