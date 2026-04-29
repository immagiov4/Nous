import type { Message, UserProfile } from './types.ts';

type JsonRepairStage = 'cleaned' | 'repaired' | 'completed';

const logJsonRepairFailure = (stage: JsonRepairStage, error: unknown): void => {
  if (!import.meta.env.DEV) {
    return;
  }

  console.warn('[Nous] JSON parse repair stage failed', {
    stage,
    error,
  });
};

export const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    logJsonRepairFailure('cleaned', error);
    // intentional: fallback to default
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

  let inString = false;
  let stringDelimiter = '"';
  let isEscaped = false;
  const stack: string[] = [];
  let lastCompleteRootEnd = -1;

  for (let index = 0; index < clean.length; index += 1) {
    const current = clean[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (current === '\\') {
        isEscaped = true;
        continue;
      }

      if (current === stringDelimiter) {
        inString = false;
        stringDelimiter = '"';
      }

      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      stringDelimiter = current;
      continue;
    }

    if (current === '{' || current === '[') {
      stack.push(current);
      continue;
    }

    if (current === '}' && stack.at(-1) === '{') {
      stack.pop();
      if (stack.length === 0) {
        lastCompleteRootEnd = index;
      }
      continue;
    }

    if (current === ']' && stack.at(-1) === '[') {
      stack.pop();
      if (stack.length === 0) {
        lastCompleteRootEnd = index;
      }
    }
  }

  if (lastCompleteRootEnd !== -1) {
    clean = clean.substring(0, lastCompleteRootEnd + 1);
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
      if ((current === '"' || current === "'") && previous !== '\\') {
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
      const isUnicodeEscape =
        next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
      const isValidEscape =
        ['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(next) || isUnicodeEscape;

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

const closeOpenJsonStructures = (text: string): string => {
  let completed = text;
  const stack: string[] = [];
  let inString = false;
  let stringDelimiter = '"';
  let isEscaped = false;

  for (let index = 0; index < completed.length; index += 1) {
    const current = completed[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (current === '\\') {
        isEscaped = true;
        continue;
      }

      if (current === stringDelimiter) {
        inString = false;
        stringDelimiter = '"';
      }

      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      stringDelimiter = current;
      continue;
    }

    if (current === '{' || current === '[') {
      stack.push(current);
      continue;
    }

    if (current === '}' && stack.at(-1) === '{') {
      stack.pop();
      continue;
    }

    if (current === ']' && stack.at(-1) === '[') {
      stack.pop();
    }
  }

  if (inString) {
    completed += '"';
  }

  completed = completed.replace(/,\s*$/, '');

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    completed += stack[index] === '{' ? '}' : ']';
  }

  return completed.replace(/,\s*([}\]])/g, '$1');
};

const buildJsonParseError = (): Error & { status?: number; details?: string } => {
  const error = new Error(
    'Il modello ha restituito una risposta incompleta o non valida. Riprova a generare il contenuto.'
  ) as Error & { status?: number; details?: string };
  error.status = 0;
  error.details = 'invalid_json_response';
  return error;
};

export const parseCleanJson = <T>(text: string): T => {
  const cleaned = cleanJson(text);

  // Model responses often fail in different ways: extra prose, invalid escapes,
  // or truncated structures. Keep each repair stage separate so dev logs show
  // which fallback actually recovered or failed the response.
  try {
    return JSON.parse(cleaned) as T;
  } catch (cleanedError) {
    logJsonRepairFailure('cleaned', cleanedError);
    const repaired = repairJsonString(cleaned);

    try {
      return JSON.parse(repaired) as T;
    } catch (repairedError) {
      logJsonRepairFailure('repaired', repairedError);
      const completed = closeOpenJsonStructures(repaired);

      try {
        return JSON.parse(completed) as T;
      } catch (completedError) {
        logJsonRepairFailure('completed', completedError);
        throw buildJsonParseError();
      }
    }
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
