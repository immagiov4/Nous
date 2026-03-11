import {
  MODEL_FLASH,
  MODEL_REASONING,
  buildAssessmentSummary,
  callOpenRouter,
  fileToDataUrl,
  plannerInstruction,
  retryWithBackoff,
  teacherInstruction,
  type FileData,
  type LearningPlan,
  type LearningSection,
  type Message,
  type QuizQuestion,
  type UserProfile,
} from './shared';

export const generateLearningPlan = async (
  file: FileData,
  assessmentHistory: Message[]
): Promise<LearningPlan> => {
  const assessmentSummary = buildAssessmentSummary(assessmentHistory);

  const prompt = `Analizza il documento allegato.
Ecco il contesto dell'utente (Assessment):
${assessmentSummary}

Crea un piano di studi dettagliato.
- Se l'utente e principiante, aggiungi capitoli 'prerequisite' corposi.
- Dividi il paper in sezioni logiche ('core').
- Aggiungi un capitolo finale di sintesi ('summary').
- Assicurati che i titoli siano descrittivi.
- La descrizione deve spiegare COSA si imparera in quella sezione.

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
        { role: 'system', content: plannerInstruction },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (!response) {
      throw new Error('No plan generated');
    }

    return JSON.parse(response) as LearningPlan;
  });
};

export const createSubChapterMetadata = async (
  file: FileData,
  parentSection: LearningSection,
  selection: string,
  userInstructions: string
): Promise<LearningSection> => {
  const prompt = `L'utente sta studiando il capitolo: "${parentSection.title}".
Descrizione capitolo: "${parentSection.description}".

L'utente ha evidenziato questo testo specifico: "${selection}".

Istruzioni dell'utente per l'approfondimento: "${userInstructions || 'Approfondisci questo concetto in dettaglio'}".

Il tuo compito e creare il METADATA per una nuova lezione (sotto-capitolo) dedicata esclusivamente a questo punto evidenziato.
Questa lezione deve essere un "Deep Dive".

Rispondi SOLO con un oggetto JSON:
{
  "title": "Titolo accattivante per la nuova lezione",
  "description": "Cosa si imparera in questo approfondimento"
}`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FLASH,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (!response) {
      throw new Error('Failed to generate sub-chapter metadata');
    }

    const json = JSON.parse(response) as { title: string; description: string };
    return {
      id: crypto.randomUUID(),
      title: json.title,
      description: json.description,
      isCompleted: false,
      type: 'deep-dive',
      parentId: parentSection.id,
    };
  });
};

export const createLearnSubChapterMetadata = async (
  parentSection: LearningSection,
  selection: string,
  userInstructions: string,
  moduleTitle: string,
  profile: UserProfile | null
): Promise<LearningSection> => {
  const prompt = `Sei un curriculum architect esperto.

CONTESTO PERCORSO: "${profile?.topic || moduleTitle || parentSection.title}"
CONTESTO STUDENTE: "${profile?.context || 'Learner in a fileless AI-generated curriculum'}"
MODULO: "${moduleTitle || 'Percorso'}"
LEZIONE PADRE: "${parentSection.title}"
DESCRIZIONE LEZIONE PADRE: "${parentSection.description}"

TESTO EVIDENZIATO DALL'UTENTE:
"${selection}"

ISTRUZIONI EXTRA DELL'UTENTE:
"${userInstructions || 'Approfondisci questo concetto in dettaglio'}"

Il tuo compito e creare il METADATA per una nuova sottolezione deep dive.
Questa sottolezione deve essere coerente con il percorso corrente ma non dipendere da un file sorgente.

Rispondi SOLO con un oggetto JSON:
{
  "title": "Titolo specifico della nuova sottolezione",
  "description": "Cosa si imparera in questo approfondimento",
  "contextPrompt": "Prompt tecnico sintetico da usare poi per generare il contenuto della sottolezione"
}`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FLASH,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    if (!response) {
      throw new Error('Failed to generate learn-mode sub-chapter metadata');
    }

    const json = JSON.parse(response) as { title: string; description: string; contextPrompt?: string };
    return {
      id: crypto.randomUUID(),
      title: json.title,
      description: json.description,
      isCompleted: false,
      type: 'deep-dive',
      parentId: parentSection.id,
      contextPrompt: json.contextPrompt || `${selection}\n\n${userInstructions || 'Approfondisci questo concetto in dettaglio'}`,
    };
  });
};

export const generateSectionContent = async (
  file: FileData,
  sectionTitle: string,
  sectionDescription: string,
  previousContext: string,
  onStatusUpdate?: (status: string) => void
): Promise<{ content: string; quiz: QuizQuestion[] }> => {
  onStatusUpdate?.('Generazione lezione completa in corso...');

  const prompt = `Sei il Professor Lumina. Devi generare una LEZIONE COMPLETA E APPROFONDITA.

TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

REGOLE FONDAMENTALI:
1. **PROFONDITA**: Questa lezione deve essere ESAUSTIVA. Non limitarti a una panoramica. 
   Spiega ogni concetto in dettaglio, con esempi concreti, formule (in LaTeX $$...$$), e codice dove appropriato.
2. **STRUTTURA DISCORSIVA**: Scrivi paragrafi completi, non liste puntate. 
   La lezione deve leggersi come un capitolo di un libro, non come una slide.
3. **RIFERIMENTI AL TESTO**: Cita specificamente il documento originale.
4. **ESEMPI E ANALOGIE**: Ogni concetto importante deve avere un esempio pratico o un'analogia.
5. **STRUTTURA**:
   - Introduzione
   - Concetti Fondamentali
   - Analisi Approfondita
   - Applicazioni Pratiche
   - Conclusione
6. **LUNGHEZZA**: E meglio essere comprensibili che concisi.

Formatta in Markdown ricco.

AL TERMINE DELLA LEZIONE:
Genera un separatore "---QUIZ---" seguito da un array JSON di 5 domande a risposta multipla basate sulla lezione.
Formato JSON Quiz: [{ "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }]`;

  const response = await retryWithBackoff(() =>
    callOpenRouter({
      model: MODEL_REASONING,
      messages: [
        { role: 'system', content: teacherInstruction },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    })
  );

  const [content, quizPart] = (response || '').split('---QUIZ---');
  let quiz: QuizQuestion[] = [];

  if (quizPart) {
    try {
      quiz = JSON.parse(quizPart.replace(/```json/g, '').replace(/```/g, '').trim()) as QuizQuestion[];
    } catch (error) {
      console.warn('Quiz parsing failed', error);
    }
  }

  return { content: content.trim(), quiz };
};

export const askContextualQuestion = async (
  file: FileData,
  selection: string,
  question: string
): Promise<string> => {
  const prompt = `L'utente ha evidenziato questo testo: "${selection}"
Domanda dell'utente: "${question}"

Rispondi in modo conciso e utile basandoti sul documento caricato.
Se la risposta e nel paper, cita il paper.`;

  return retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_FLASH,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileToDataUrl(file) } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    return response || 'Non ho potuto generare una risposta.';
  });
};
