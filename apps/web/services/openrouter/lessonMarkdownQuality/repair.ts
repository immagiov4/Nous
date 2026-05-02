import { MEDIUM_REASONING_CONFIG } from '../config.ts';
import { buildUserGenerationNotesBlock } from '../prompts.ts';
import {
  callOpenRouter,
  MODEL_REASONING,
  retryWithBackoff,
  teacherInstruction,
} from '../shared.ts';
import { MAX_LESSON_REPAIR_SOURCE_CHARS } from './constants.ts';

// ── Constants ──────────────────────────────────────────────────────────

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;
const LABEL_BODY_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s+(.+)$/;
const STANDALONE_LABEL_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s*$/;
const _MAX_LIST_LABEL_WORDS = 12;
const REPETITION_SIMILARITY_THRESHOLD = 0.72;
const REPETITION_SECONDARY_KEYWORD_THRESHOLD = 0.2;
const REPETITION_FULL_WORD_OVERLAP_THRESHOLD = 0.45;
const REPETITION_MIN_SHARED_KEYWORDS = 3;
const REPETITION_RECENT_PARAGRAPH_WINDOW = 4;
const REPETITION_MIN_KEYWORD_COUNT = 8;
const PARAGRAPH_REPETITION_STOP_WORDS = new Set([
  'alla',
  'alle',
  'anche',
  'avere',
  'come',
  'core',
  'cosa',
  'cui',
  'dalla',
  'dalle',
  'della',
  'delle',
  'dello',
  'dentro',
  'dopo',
  'essere',
  'framework',
  'function',
  'functions',
  'hanno',
  'loro',
  'nelle',
  'nella',
  'non',
  'organization',
  'organizzazione',
  'organizzazioni',
  'partire',
  'perche',
  'pero',
  'questa',
  'queste',
  'questi',
  'questo',
  'quindi',
  'risultati',
  'risultato',
  'sono',
  'solo',
  'stessa',
  'stesso',
  'subcategories',
  'subcategory',
  'tutte',
  'tutti',
]);

const LESSON_CONCLUSION_HEADING_REGEX = /(^|\n)#{1,6}\s+Conclusione\b/i;
const LESSON_ABORTED_ENDING_REGEX =
  /(include|includono|comprende|comprendono|principali sono|si dividono in|origini includono)\s*:\s*$/i;
const BROKEN_DISPLAY_MATH_BRACKET_REGEX = /(^|\n)\[\s*\n[\s\S]*?\n\]\s*(?=\n|$)/m;
const BROKEN_KATEX_DELIMITER_REGEX = /(^|\n)(?:\[\s*$|\]\s*$)/m;
const SPLIT_TEXT_PSEUDOCODE_FENCE_REGEX =
  /```text\s*\n(?:IF|FOR|WHILE|RETURN|[A-Za-z_]\w*\(|\s*[A-Za-z_]\w*\s*=|\s*})[\s\S]*?\n```\s*\n+(?:\s*(?:IF|ELSE|FOR|WHILE|RETURN|[A-Za-z_]\w*\(|[A-Za-z_]\w*\s*=|})\b|\s+\S)[\s\S]{0,800}?```text\s*\n/gi;

// ── Helper functions ───────────────────────────────────────────────────

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const stripMarkdownForSimilarity = (value: string): string =>
  value
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/[*_#>|[\]()`~]/g, ' ')
    .replace(/\{\{PDF_IMAGE:[^}]+\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeSimilarityWord = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

const extractParagraphKeywords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 4 && !PARAGRAPH_REPETITION_STOP_WORDS.has(word))
    )
  );

const extractParagraphWords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 2)
    )
  );

interface ParagraphSimilarityMetrics {
  fullWordOverlap: number;
  keywordOverlap: number;
  sharedKeywordCount: number;
}

const computeParagraphSimilarity = (left: string, right: string): ParagraphSimilarityMetrics => {
  const leftKeywords = extractParagraphKeywords(left);
  const rightKeywords = extractParagraphKeywords(right);
  const leftWords = extractParagraphWords(left);
  const rightWords = extractParagraphWords(right);
  const rightWordSet = new Set(rightWords);
  const sharedWordCount = leftWords.filter(word => rightWordSet.has(word)).length;
  const rightKeywordSet = new Set(rightKeywords);
  const sharedKeywordCount = leftKeywords.filter(keyword => rightKeywordSet.has(keyword)).length;

  return {
    fullWordOverlap: sharedWordCount / Math.max(1, Math.min(leftWords.length, rightWords.length)),
    keywordOverlap:
      leftKeywords.length < REPETITION_MIN_KEYWORD_COUNT ||
      rightKeywords.length < REPETITION_MIN_KEYWORD_COUNT
        ? 0
        : sharedKeywordCount / Math.max(1, Math.min(leftKeywords.length, rightKeywords.length)),
    sharedKeywordCount,
  };
};

const isRedundantParagraphMatch = (metrics: ParagraphSimilarityMetrics): boolean =>
  metrics.keywordOverlap >= REPETITION_SIMILARITY_THRESHOLD ||
  (metrics.sharedKeywordCount >= REPETITION_MIN_SHARED_KEYWORDS &&
    metrics.keywordOverlap >= REPETITION_SECONDARY_KEYWORD_THRESHOLD &&
    metrics.fullWordOverlap >= REPETITION_FULL_WORD_OVERLAP_THRESHOLD);

const isMeaningfulParagraphForRepetitionCheck = (paragraph: string): boolean => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (!normalized || BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) return false;
  return extractParagraphKeywords(paragraph).length >= REPETITION_MIN_KEYWORD_COUNT;
};

interface RepetitionHit {
  currentIndex: number;
  previousIndex: number;
  similarity: number;
}

const findRedundantParagraphPairs = (paragraphs: string[]): RepetitionHit[] => {
  const hits: RepetitionHit[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (!isMeaningfulParagraphForRepetitionCheck(paragraph)) return;
    const startIndex = Math.max(0, index - REPETITION_RECENT_PARAGRAPH_WINDOW);
    for (let previousIndex = startIndex; previousIndex < index; previousIndex += 1) {
      const previousParagraph = paragraphs[previousIndex];
      if (!isMeaningfulParagraphForRepetitionCheck(previousParagraph)) continue;
      const similarity = computeParagraphSimilarity(previousParagraph, paragraph);
      if (isRedundantParagraphMatch(similarity)) {
        hits.push({
          currentIndex: index,
          previousIndex,
          similarity: Math.max(similarity.keywordOverlap, similarity.fullWordOverlap),
        });
        break;
      }
    }
  });
  return hits;
};

// ── Issue detection ────────────────────────────────────────────────────

const getLessonMarkdownIssues = (contentMarkdown: string): string[] => {
  const issues: string[] = [];
  const trimmed = contentMarkdown.trim();
  if (!trimmed) return ['Il contenuto e vuoto.'];

  if (/[:;,]\s*$/.test(trimmed) || LESSON_ABORTED_ENDING_REGEX.test(trimmed)) {
    issues.push(
      'La lezione sembra tronca o si interrompe su un elenco introdotto ma non completato.'
    );
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  const labelLikeParagraphs = paragraphs.filter(paragraph => {
    const normalized = normalizeParagraphForDetection(paragraph);
    return (
      !BLOCKISH_PARAGRAPH_PREFIX.test(normalized) &&
      (LABEL_BODY_REGEX.test(normalized) || STANDALONE_LABEL_REGEX.test(normalized))
    );
  }).length;

  if (paragraphs.length >= 8 && labelLikeParagraphs / paragraphs.length > 0.35) {
    issues.push('La prosa e troppo frammentata in blocchi stile lista o pseudo-lista.');
  }

  const meaningfulLines = trimmed
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^(#{1,6}\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/.test(l));
  const markdownListLines = meaningfulLines.filter(line => /^([-*+]|\d+\.)\s+/.test(line)).length;
  if (meaningfulLines.length >= 14 && markdownListLines / meaningfulLines.length > 0.4) {
    issues.push('La lezione usa troppe liste rispetto ai paragrafi discorsivi.');
  }

  const redundantParagraphPairs = findRedundantParagraphPairs(paragraphs);
  if (redundantParagraphPairs.length > 0) {
    issues.push(
      'La lezione ribadisce piu volte lo stesso concetto in paragrafi troppo simili tra loro.'
    );
  }

  if (trimmed.length > 3500 && !LESSON_CONCLUSION_HEADING_REGEX.test(trimmed)) {
    issues.push('Manca una conclusione esplicita.');
  }

  if (
    BROKEN_DISPLAY_MATH_BRACKET_REGEX.test(trimmed) ||
    BROKEN_KATEX_DELIMITER_REGEX.test(trimmed)
  ) {
    issues.push(
      'La formattazione KaTeX/LaTeX sembra malformata: correggi delimitatori e sintassi matematica per il rendering.'
    );
  }

  if (SPLIT_TEXT_PSEUDOCODE_FENCE_REGEX.test(trimmed)) {
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
  generationNotes?: string
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
12. Mantieni heading chiari e chiudi con una sezione "Conclusione".
13. Se due paragrafi stanno difendendo la stessa tesi o ribadendo lo stesso contrasto concettuale, fondili in uno solo e tieni soltanto la formulazione piu chiara e utile.
14. NON inserire quiz nel testo.
15. NON inserire markdown image syntax, tag <img> o riferimenti ad asset tecnici.
16. Normalizza i blocchi di codice Markdown: usa solo fence standard del tipo \`\`\` oppure \`\`\`lang con il SOLO nome del linguaggio (es. \`\`\`cpp). Non aggiungere commenti, etichette o testo extra sulla stessa riga del fence.
17. Per pseudocodice o codice multilinea, NON alternare blocchi \`\`\`text\` e righe fuori dal blocco: ogni esempio deve stare in UN SOLO code block, includendo firma, corpo, parentesi graffe e RETURN.
18. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, fallo con una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
19. Correggi e normalizza anche la formattazione KaTeX/LaTeX: formule inline solo come \`$...$\` oppure \`\\(...\\)\`; formule display solo come \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare mai righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, e assicurati che parentesi, graffe e delimitatori siano bilanciati.
20. Restituisci SOLO markdown pulito, senza JSON e senza spiegazioni.

CONTESTO SORGENTE:
${sourceContext.slice(0, MAX_LESSON_REPAIR_SOURCE_CHARS)}

BOZZA ATTUALE DA REVISIONARE:
${contentMarkdown}`;

  return retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        reasoning: MEDIUM_REASONING_CONFIG,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: repairPrompt },
        ],
        temperature: 0.15,
      }),
    1,
    500
  );
};
