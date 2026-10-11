import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INVALID_MERMAID_RESPONSE_MESSAGE = 'Mermaid validation process returned an invalid response.';

const runMermaidValidation = (
  input: string,
  signal: AbortSignal,
  args: string[]
): Promise<string> => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL('./mermaidValidationProcess.mjs', import.meta.url)), ...args],
      { signal, windowsHide: true },
      (error, stdout) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else if (error) {
          reject(new Error('Mermaid validation process failed.', { cause: error }));
        } else {
          resolve(stdout);
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
    child.stdin?.end(input);
  });
};

/** Parses in an isolated DOM process; classification callers may treat unknown types as non-diagrams. */
export const isParseableMermaid = (
  code: string,
  signal: AbortSignal,
  unknownDiagramIsInvalid = false
): Promise<boolean> =>
  runMermaidValidation(code, signal, unknownDiagramIsInvalid ? ['--allow-non-diagram'] : []).then(
    stdout => {
      if (stdout === 'valid' || stdout === 'invalid') return stdout === 'valid';
      throw new Error(INVALID_MERMAID_RESPONSE_MESSAGE);
    }
  );

/** Classifies all inputs in one isolated DOM process, preserving their order. */
export const classifyMermaidInputs = async (
  codes: readonly string[],
  signal: AbortSignal
): Promise<boolean[]> => {
  signal.throwIfAborted();
  if (codes.length === 0) return [];
  const stdout = await runMermaidValidation(JSON.stringify(codes), signal, ['--classify-batch']);
  let results: unknown;
  try {
    results = JSON.parse(stdout);
  } catch {
    throw new Error(INVALID_MERMAID_RESPONSE_MESSAGE);
  }
  if (
    !Array.isArray(results) ||
    results.length !== codes.length ||
    !results.every(result => typeof result === 'boolean')
  ) {
    throw new Error(INVALID_MERMAID_RESPONSE_MESSAGE);
  }
  return results;
};
