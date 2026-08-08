const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

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
      /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)(\s*[=:]\s*)[^\s,;"']+/gi,
      '$1$2[REDACTED]'
    )
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT REDACTED]')
    .replaceAll(/\b(?:github_pat|gh[opsu]|sk)[-_]?[A-Za-z0-9_-]{16,}\b/g, '[SECRET REDACTED]')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics may contain unsafe terminal control bytes.
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
    .trim();
