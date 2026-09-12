import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Parses with the bundled Mermaid in a disposable DOM process, isolated from server globals. */
export const isParseableMermaid = (code: string, signal: AbortSignal): Promise<boolean> => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('./mermaidValidationProcess.mjs', import.meta.url))],
      { signal, windowsHide: true },
      (error, stdout) => {
        if (error) {
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
      reject(new Error('Mermaid validation input failed.', { cause: error }));
    });
    child.stdin?.end(code);
  });
};
