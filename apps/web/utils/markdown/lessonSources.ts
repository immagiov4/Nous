const TERMINAL_LESSON_SOURCES_SECTION =
  /(?:^|\n)#{2,3}\s*(?:fonti\s+(?:essenziali|della\s+(?:lezione|sezione))|(?:essential|lesson|section)\s+sources|sources)\s*\n[\s\S]*$/iu;

/** Removes a generated bibliography when sources are rendered from structured lesson data. */
export const stripTerminalLessonSourcesSection = (content: string): string =>
  content.replace(TERMINAL_LESSON_SOURCES_SECTION, '').trimEnd();
