import { TRANSCRIBED_SOURCE_RULE } from '@shared/pdfTranscription';

/** Shared grounding policy for lesson authors and factual reviewers. */
export const LESSON_FACTUAL_SUPPORT_RULE = `${TRANSCRIBED_SOURCE_RULE}
A factual claim is supported when it is stated in the course source or in the research dossier with source attribution. An attributed research note is sufficient evidence; an independently retrieved verbatim excerpt is not required. Preserve the dossier's attributedSources. A dossier statement can be attributed through its accompanying source catalog and notes; an inline citation or a note repeating every qualification verbatim is not required. A source title or URL without supporting course or dossier content, or agreement with model memory alone, is insufficient. Only additional factual claims drawn from model knowledge without attribution are unsupported. Preserve source-specific qualifications and check contradictions against the supplied source content.`;
