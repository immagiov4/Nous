const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const SENSITIVE_FIELD_NAME_PATTERN =
  /^(?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret)$/iu;

export const sanitizeDiagnosticText = (value: string, maxLength: number): string =>
  value
    .replaceAll(HTTP_URL_PATTERN, rawUrl => {
      try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[URL REDACTED]';
      }
    })
    .replaceAll(EMAIL_PATTERN, '[EMAIL REDACTED]')
    .replaceAll(/\b(authorization)(\s*[=:]\s*)[^\r\n]+/gi, '$1$2[REDACTED]')
    .replaceAll(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replaceAll(
      /\b(access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret)(\s*[=:]\s*)[^\s,;"']+/gi,
      '$1$2[REDACTED]'
    )
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT REDACTED]')
    .replaceAll(/\b(?:github_pat|gh[opsu]|sk)[-_]?[A-Za-z0-9_-]{16,}\b/g, '[SECRET REDACTED]')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics may contain unsafe terminal control bytes.
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
    .trim();

export const sanitizeDiagnosticPayload = (value: string, maxLength: number): string => {
  if (/^\s*[[{]/u.test(value)) {
    try {
      return sanitizeDiagnosticText(
        JSON.stringify(JSON.parse(value), (key, nestedValue) =>
          SENSITIVE_FIELD_NAME_PATTERN.test(key) ? '[REDACTED]' : nestedValue
        ),
        maxLength
      );
    } catch {
      return sanitizeDiagnosticText(value, maxLength);
    }
  }
  return sanitizeDiagnosticText(value, maxLength);
};

export const readDiagnosticResponseText = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let detail = '';
  try {
    while (detail.length < 2048) {
      const chunk = await reader.read();
      if (chunk.done) break;
      detail += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // Status is still useful if the error body cannot be read.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return sanitizeDiagnosticPayload(detail, 2048);
};
