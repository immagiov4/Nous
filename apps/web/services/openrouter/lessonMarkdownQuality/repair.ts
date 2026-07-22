import { MEDIUM_REASONING_CONFIG } from '../config.ts';
import {
  buildUserGenerationNotesBlock,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
} from '../prompts.ts';
import {
  callOpenRouter,
  MODEL_REASONING,
  retryWithBackoff,
  teacherInstruction,
} from '../shared.ts';
import {
  hasBrokenDisplayMathBracketBlock,
  hasBrokenKatexDelimiterLine,
  hasSplitTextPseudocodeFence,
} from './markdownHeuristics.ts';

// ── Issue detection ────────────────────────────────────────────────────

const getLessonMarkdownIssues = (contentMarkdown: string): string[] => {
  const issues: string[] = [];
  const trimmed = contentMarkdown.trim();
  if (!trimmed) return ['Il contenuto e vuoto.'];

  if (hasBrokenDisplayMathBracketBlock(trimmed) || hasBrokenKatexDelimiterLine(trimmed)) {
    issues.push(
      'La formattazione KaTeX/LaTeX sembra malformata: correggi delimitatori e sintassi matematica per il rendering.'
    );
  }

  if (hasSplitTextPseudocodeFence(trimmed)) {
    issues.push(
      'Gli esempi di pseudocodice sono spezzati in piu blocchi ```text con righe del corpo fuori dal blocco: unisci ogni esempio in un unico code block.'
    );
  }

  return issues;
};

// ── Repair prompt construction ─────────────────────────────────────────

export const repairLessonMarkdown = async (
  contentMarkdown: string,
  sectionTitle: string,
  sectionDescription: string,
  sourceContext: string,
  generationNotes?: string,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<string> => {
  const issues = getLessonMarkdownIssues(contentMarkdown);
  if (issues.length === 0) return contentMarkdown;

  const userNotesBlock = buildUserGenerationNotesBlock(generationNotes);

  const repairPrompt = `Sei un editor didattico di Nous Reader.

Devi REVISIONARE una lezione markdown gia generata.
${userNotesBlock}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"

PROBLEMI DA CORREGGERE:
${issues.map(issue => `- ${issue}`).join('\n')}

REGOLE:
1. Mantieni i contenuti validi e il significato tecnico originale.
2. Se il testo e troncato, completalo in modo coerente usando il contesto sorgente.
3. Riduci lo stile lista-like: preferisci paragrafi completi e usa liste solo per vere enumerazioni.
4. Elimina ripetizioni inutili, parafrasi ravvicinate e reiterazioni della stessa idea tra sezioni vicine.
5. Non ripetere il titolo della lezione nel corpo e non lasciare heading duplicati o consecutivi identici.
6. Taglia frasi metadiscorsive o riempitive come "questo e importante", "in pratica", "il punto centrale e" quando non aggiungono informazione tecnica nuova.
7. Mantieni il tono discorsivo, ma riduci analogie ed esempi superflui: usa analogie solo per concetti davvero difficili o astratti, non come abitudine stilistica.
8. Non lasciare sigle, abbreviazioni o acronimi non spiegati: alla prima occorrenza scioglili e chiariscili.
9. Evita forestierismi inutili: se esiste un equivalente italiano naturale e chiaro, preferiscilo.
10. Preferisci spiegazioni dirette ed esempi tratti dal materiale sorgente. Evita formule ricorrenti come "l'analogia piu utile e", "pensiamolo come", "e come se" salvo casi rari in cui chiariscono davvero un passaggio difficile.
11. Evita il tono da saggio divulgativo: niente piccoli riassunti, tesi di paragrafo o frasi che riformulano subito la stessa idea con parole diverse.
12. Mantieni heading chiari senza imporre sezioni aggiuntive.
13. Se due paragrafi stanno difendendo la stessa tesi o ribadendo lo stesso contrasto concettuale, fondili in uno solo e tieni soltanto la formulazione piu chiara e utile.
14. NON inserire domande, opzioni o sezioni quiz nel testo; i marker quiz inline esistenti non sono contenuto del quiz e vanno conservati.
15. NON inserire markdown image syntax, tag <img> o riferimenti ad asset tecnici.
16. Normalizza i blocchi di codice Markdown: usa solo fence standard del tipo \`\`\` oppure \`\`\`lang con il SOLO nome del linguaggio (es. \`\`\`cpp). Non aggiungere commenti, etichette o testo extra sulla stessa riga del fence.
17. Per pseudocodice o codice multilinea, NON alternare blocchi \`\`\`text\` e righe fuori dal blocco: ogni esempio deve stare in UN SOLO code block, includendo firma, corpo, parentesi graffe e RETURN.
18. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, fallo con una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
19. Correggi e normalizza anche la formattazione KaTeX/LaTeX: formule inline solo come \`$...$\` oppure \`\\(...\\)\`; formule display solo come \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare mai righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, e assicurati che parentesi, graffe e delimitatori siano bilanciati.
20. Conserva integralmente i marker strutturati \`{{YOUTUBE_CLIP_SOURCE:...}}\`, \`{{VISUAL_SLOT:...}}\` e \`{{INLINE_QUIZ:...}}\`; puoi spostarli insieme al paragrafo pertinente, ma non riscriverli o eliminarli.
21. Restituisci SOLO markdown pulito, senza JSON e senza spiegazioni.

CONTESTO SORGENTE:
${sourceContext}

BOZZA ATTUALE DA REVISIONARE:
${contentMarkdown}`;

  return retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        modelSlot: 'lesson',
        onReasoningUpdate,
        reasoning: MEDIUM_REASONING_CONFIG,
        messages: [
          {
            role: 'system',
            content: `${teacherInstruction}\n\n${INTERNAL_REASONING_EFFICIENCY_INSTRUCTION}`,
          },
          { role: 'user', content: repairPrompt },
        ],
        temperature: 0.15,
      }),
    1,
    500
  );
};
