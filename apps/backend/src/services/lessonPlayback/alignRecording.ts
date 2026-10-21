import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignedWordTimes, narrationWords } from '@shared/playbackWordTiming';

/** Runs the unmodified aeneas CLI outside the backend process; all intermediates use /tmp. */
export async function alignRecording(input: {
  bytes: Uint8Array;
  speech: string;
  durationSeconds: number;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'nous-alignment-'));
  try {
    const audio = join(directory, 'audio.mp3');
    const text = join(directory, 'words.txt');
    const output = join(directory, 'alignment.json');
    await Promise.all([
      writeFile(audio, input.bytes),
      writeFile(
        text,
        narrationWords(input.speech)
          .map(word => word.text)
          .join('\n')
      ),
    ]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.env.AENEAS_PYTHON ?? '/opt/aeneas/bin/python',
        [
          '-m',
          'aeneas.tools.execute_task',
          audio,
          text,
          'task_language=ita|is_text_type=plain|os_task_file_format=json',
          output,
          '--presets-word',
        ],
        { signal: input.signal, windowsHide: true, stdio: 'ignore' }
      );
      let failure: Error | undefined;
      child.once('error', error => {
        failure = error;
      });
      child.once('close', code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error('Recording alignment failed.'));
      });
    });
    input.signal.throwIfAborted();
    const result: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (
      !result ||
      typeof result !== 'object' ||
      !('fragments' in result) ||
      !Array.isArray(result.fragments)
    )
      throw new Error('Invalid alignment output.');
    const words = narrationWords(input.speech);
    const onsets = result.fragments.map((fragment: unknown, index: number) => {
      if (
        !fragment ||
        typeof fragment !== 'object' ||
        !('begin' in fragment) ||
        !('lines' in fragment) ||
        !Array.isArray(fragment.lines) ||
        fragment.lines.length !== 1 ||
        fragment.lines[0] !== words[index]?.text
      )
        throw new Error('Alignment does not match canonical narration.');
      return Number(fragment.begin);
    });
    const alignment = { status: 'aligned' as const, onsets };
    if (!alignedWordTimes(input.speech, input.durationSeconds, alignment))
      throw new Error('Invalid recording word onsets.');
    return alignment;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
