import type { Message, UserProfile } from './types';

export const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export const cleanJson = (text: string): string => {
  let clean = text.replace(/```json\n?|```/g, '').trim();
  const firstBracket = clean.indexOf('[');
  const firstBrace = clean.indexOf('{');
  const start =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)
      ? firstBracket
      : firstBrace;

  if (start !== -1) {
    clean = clean.substring(start);
  }

  const lastBracket = clean.lastIndexOf(']');
  const lastBrace = clean.lastIndexOf('}');
  const end =
    lastBracket !== -1 && (lastBrace === -1 || lastBracket > lastBrace)
      ? lastBracket
      : lastBrace;

  if (end !== -1) {
    clean = clean.substring(0, end + 1);
  }

  clean = clean.replace(/\\u(?![0-9a-fA-F]{4})/g, 'u');

  return clean;
};

export const repairJsonString = (text: string): string => {
  let repaired = '';
  let inString = false;
  let stringDelimiter = '"';

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const previous = index > 0 ? text[index - 1] : '';
    const next = index < text.length - 1 ? text[index + 1] : '';

    if (!inString) {
      repaired += current;
      if ((current === '"' || current === '\'') && previous !== '\\') {
        inString = true;
        stringDelimiter = current;
      }
      continue;
    }

    if (current === '\n') {
      repaired += '\\n';
      continue;
    }

    if (current === '\r') {
      repaired += '\\r';
      continue;
    }

    if (current === '\t') {
      repaired += '\\t';
      continue;
    }

    if (current === '\\') {
      const isUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
      const isValidEscape = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(next) || isUnicodeEscape;

      if (!next || !isValidEscape) {
        repaired += '\\\\';
        continue;
      }
    }

    repaired += current;

    if (current === stringDelimiter && previous !== '\\') {
      inString = false;
      stringDelimiter = '"';
    }
  }

  return repaired.replace(/,\s*([}\]])/g, '$1');
};

export const parseCleanJson = <T>(text: string): T => {
  const cleaned = cleanJson(text);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return JSON.parse(repairJsonString(cleaned)) as T;
  }
};

export const sanitizeTitle = (title: string): string => {
  if (!title) {
    return 'Untitled Lesson';
  }

  const clean = title
    .replace(/^(Output|Rule|Strict|Instruction|Task|Topic).*?:/i, '')
    .replace(/["*_]/g, '')
    .trim();

  const words = clean.split(' ');
  return words.length > 10 ? `${words.slice(0, 10).join(' ')}...` : clean;
};

export const parseFunctionCallProfile = (response: string): UserProfile | null => {
  const parsed = parseJson<Record<string, unknown> | null>(response, null);
  if (!parsed) {
    return null;
  }

  if (
    typeof parsed.topic === 'string' &&
    typeof parsed.experienceLevel === 'string' &&
    typeof parsed.learningStyle === 'string' &&
    typeof parsed.goals === 'string' &&
    typeof parsed.context === 'string'
  ) {
    return {
      topic: parsed.topic,
      experienceLevel: parsed.experienceLevel,
      learningStyle: parsed.learningStyle,
      goals: parsed.goals,
      context: parsed.context,
      language: typeof parsed.language === 'string' ? parsed.language : 'Italiano',
    };
  }

  return null;
};

export const buildAssessmentSummary = (assessmentHistory: Message[]): string =>
  assessmentHistory.map(message => `${message.role.toUpperCase()}: ${message.text}`).join('\n');
