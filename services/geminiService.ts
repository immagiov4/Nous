import { FileData, LearningPlan, Message, LearningSection, VoiceName } from "../types";
import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from "../constants";

// OpenRouter API Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Model configuration from environment variables
export const MODEL_FLASH = process.env.MODEL_FLASH || 'google/gemini-3-flash-preview';
export const MODEL_REASONING = process.env.MODEL_REASONING || 'google/gemini-3-flash-preview';

// Max output tokens from environment (default: 32000)
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '32000', 10);

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
      max_tokens: options.max_tokens ?? MAX_OUTPUT_TOKENS,
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
          model: MODEL_FLASH,
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
      model: MODEL_REASONING,
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
      model: MODEL_FLASH,
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
 * Single-pass generation with high token limit for comprehensive lessons.
 */
export const generateSectionContent = async (
  file: FileData,
  sectionTitle: string,
  sectionDescription: string,
  previousContext: string,
  onStatusUpdate?: (status: string) => void
): Promise<{ content: string; quiz: any[] }> => {
  
  if (onStatusUpdate) onStatusUpdate("Generazione lezione completa in corso...");

  const prompt = `Sei il Professor Lumina. Devi generare una LEZIONE COMPLETA E APPROFONDITA.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

CONTESTO PRECEDENTE: ${previousContext || "Inizio percorso"}.

REGOLE FONDAMENTALI:
1. **PROFONDITÀ**: Questa lezione deve essere ESAUSTIVA. Non limitarti a una panoramica. 
   Spiega ogni concetto in dettaglio, con esempi concreti, formule (in LaTeX $$...$$), e codice dove appropriato.
   
2. **STRUTTURA DISCORSIVA**: Scrivi paragrafi completi, non liste puntate. 
   La lezione deve leggersi come un capitolo di un libro, non come una slide.

3. **RIFERIMENTI AL TESTO**: Cita specificamente il documento originale.
   Es. "L'autore, nella sezione X, introduce questo concetto come..."

4. **ESEMPI E ANALOGIE**: Ogni concetto importante deve avere un esempio pratico o un'analogia.

5. **STRUTTURA**:
   - Introduzione (il contesto e perché importa)
   - Concetti Fondamentali (spiegati in dettaglio)
   - Analisi Approfondita (con riferimenti al testo)
   - Applicazioni Pratiche
   - Conclusione (sintesi e connessioni con il prossimo argomento)

6. **LUNGHEZZA**: Non preoccuparti di essere troppo lungo. Una lezione completa può essere lunga.
   È meglio essere comprensibili che concisi.

Formatta in Markdown ricco.

AL TERMINE DELLA LEZIONE:
Genera un separatore "---QUIZ---" seguito da un array JSON di 5 domande a risposta multipla basate sulla lezione.
Formato JSON Quiz: [{ "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }]`;

  const response = await retryWithBackoff(async () => {
    return await callOpenRouter({
      model: MODEL_REASONING,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION_TEACHER },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt }
          ]
        }
      ]
    });
  });

  const rawText = response || "";
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
      model: MODEL_FLASH,
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

// Backend TTS API URL
const BACKEND_URL = 'http://localhost:3001';

/**
 * Generates audio speech from text using the local TTS server.
 * Supports both legacy Gemini voices (for backward compatibility) and new Qwen3-TTS voices.
 */
export const generateSpeech = async (text: string, voice: VoiceName): Promise<ArrayBuffer> => {
  // Map legacy Gemini voices to new TTS voices
  const voiceMapping: Record<string, string> = {
    'Kore': 'giulia',    // Female voice
    'Fenrir': 'marco',   // Male voice
    'Puck': 'marco',     // Male voice
    'Zephyr': 'giulia',  // Female voice
    'Charon': 'marco',   // Male voice
    'Marco': 'marco',    // Direct mapping
    'Giulia': 'giulia'   // Direct mapping
  };

  const ttsVoice = voiceMapping[voice] || 'marco';

  try {
    const response = await fetch(`${BACKEND_URL}/api/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice: ttsVoice,
        speed: 1.0
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`TTS API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
    }

    return response.arrayBuffer();
  } catch (error: any) {
    // Check if it's a connection error
    if (error.code === 'ECONNREFUSED' || error.message?.includes('Failed to fetch')) {
      throw new Error('TTS server is not running. Please start the server with "npm run dev"');
    }
    throw error;
  }
};

/**
 * Check if the TTS server is available and ready.
 */
export const checkTTSStatus = async (): Promise<{ isRunning: boolean; isReady: boolean; error?: string }> => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return { isRunning: false, isReady: false, error: `Status check failed: ${response.status}` };
    }

    const data = await response.json();
    return {
      isRunning: data.status?.isRunning || false,
      isReady: data.status?.isReady || false,
      error: data.status?.lastError
    };
  } catch (error: any) {
    return {
      isRunning: false,
      isReady: false,
      error: error.message || 'Connection failed'
    };
  }
};

/**
 * Get available TTS voices.
 */
export const getTTSVoices = async (): Promise<{ id: string; name: string; language: string }[]> => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/voices`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.voices || [];
  } catch {
    return [];
  }
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
    clean = clean.replace(/\\(?![bfnrtu"\\/])/g, '');
    
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
        model: MODEL_FLASH,
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

  onStatusUpdate("Generating comprehensive lesson...");
  
  const studentContext = profile?.context || "General Learner";
  const studentLevel = profile?.experienceLevel || "Intermediate";
  const studentLang = profile?.language || "Italian";

  const prompt = `ROLE: World-Class Technical Author & Professor.
TONE: Authoritative, "No BS", Charismatic, Narrative-driven.

LESSON: "${lessonTitle}" (Module: "${moduleTitle}")
DESCRIPTION: "${currentLessonDescription}"

STUDENT: ${studentContext}
LEVEL: ${studentLevel}
LANG: ${studentLang}

TECHNICAL CONTEXT: "${contextPrompt || "Explain this clearly."}"

PAST TOPICS (already covered): ${pastContext || "None - this is the first lesson"}
FUTURE TOPICS (coming next): ${futureContext || "End of curriculum"}

CRITICAL WRITING RULES:
1. **The Bridge**: If this lesson covers distinct layers (e.g., UI vs Database), you MUST explain the connection. 
2. **The Hook**: Start with a paradox or a bold statement. Never say "Welcome".
3. **Visuals**: DO NOT use Mermaid diagrams or any other diagramming language. We cannot render them. Use standard markdown tables, lists, or ASCII art if visual representation is needed.
4. **Code**: Use realistic, detailed examples.
5. **Depth**: Write a COMPREHENSIVE, DEEP-DIVE lesson. Do not rush. Expand on concepts thoroughly, explain the 'Why' and 'How' in detail, and provide substantial content. This lesson should be LONG and THOROUGH.
6. **Structure**: 
   - The Concept (The Mental Model)
   - The Architecture (The 'Why')
   - The Implementation (The 'How')
   - The Trap (What goes wrong)

FORMAT: Markdown.`;

  const response = await retryWithBackoff(async () => {
    return await callOpenRouter({
        model: MODEL_REASONING,
        messages: [{ role: 'user', content: prompt }]
    });
  }, 2, 1000);

  let finalText = response || "";
  finalText = finalText.replace(/^Here is.*?:\s*/i, '')
                       .replace(/^Certamente.*?:\s*/i, '')
                       .replace(/```json/g, '')
                       .trim();

  return finalText;
};