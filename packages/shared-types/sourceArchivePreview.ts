export const SOURCE_ARCHIVE_PREVIEW_MAX_LINES = 24;
export const SOURCE_ARCHIVE_PREVIEW_MAX_CHARS = 8_000;

export const createSourceArchivePreview = (text: string): string => {
  let preview = '';
  let lineCount = 1;

  for (
    let index = 0;
    index < text.length && preview.length < SOURCE_ARCHIVE_PREVIEW_MAX_CHARS;
    index += 1
  ) {
    let character = text[index];
    if (character === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      character = '\n';
    }

    if (character === '\n') {
      if (lineCount >= SOURCE_ARCHIVE_PREVIEW_MAX_LINES) {
        break;
      }
      lineCount += 1;
    }
    preview += character;
  }

  return preview;
};
