import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Parses in an isolated DOM process; classification callers may treat unknown types as non-diagrams. */
export const isParseableMermaid = (
  code: string,
  signal: AbortSignal,
  unknownDiagramIsInvalid = false
): Promise<boolean> => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        fileURLToPath(new URL('./mermaidValidationProcess.mjs', import.meta.url)),
        ...(unknownDiagramIsInvalid ? ['--allow-non-diagram'] : []),
      ],
      { signal, windowsHide: true },
      (error, stdout) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else if (error) {
          reject(new Error('Mermaid validation process failed.', { cause: error }));
        } else if (stdout === 'valid' || stdout === 'invalid') {
          resolve(stdout === 'valid');
        } else {
          reject(new Error('Mermaid validation process returned an invalid response.'));
        }
      }
    );
    child.stdin?.on('error', error => {
      child.kill();
      reject(
        signal.aborted
          ? signal.reason
          : new Error('Mermaid validation input failed.', { cause: error })
      );
    });
    child.stdin?.end(code);
  });
};
