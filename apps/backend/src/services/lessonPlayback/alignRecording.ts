import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignedWordTimes, narrationWords } from '@shared/playbackWordTiming';
import { trimRecordingSilence } from './alignmentEnergy.js';
import { alignmentLanguage } from './alignmentLanguage.js';

/** Runs the unmodified aeneas CLI outside the backend process; all intermediates use /tmp. */
export async function alignRecording(input: {
  bytes: Uint8Array;
  speech: string;
  durationSeconds: number;
  language: string;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const language = alignmentLanguage(input.language);
  const directory = await mkdtemp(join(tmpdir(), 'nous-alignment-'));
  try {
    const audio = join(directory, 'audio.mp3');
    const text = join(directory, 'words.txt');
    const output = join(directory, 'alignment.json');
    await Promise.all([
      writeFile(audio, input.bytes),
      writeFile(
        text,
        Array.from(
          new Intl.Segmenter(language, { granularity: 'sentence' }).segment(
            narrationWords(input.speech)
              .map(word => word.text)
              .join(' ')
          ),
          // Explicit clause boundaries constrain word alignment across audible pauses too.
          sentence => sentence.segment.trim().replaceAll(/([,;:])\s+/gu, '$1\n')
        ).join('\n')
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
          `task_language=${language}|is_text_type=mplain|os_task_file_format=json|os_task_file_levels=3`,
          output,
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
    const fragments = result.fragments.map((fragment: unknown, index: number) => {
      if (
        !fragment ||
        typeof fragment !== 'object' ||
        !('begin' in fragment) ||
        !('end' in fragment) ||
        !('lines' in fragment) ||
        !Array.isArray(fragment.lines) ||
        fragment.lines.length !== 1 ||
        fragment.lines[0] !== words[index]?.text
      )
        throw new Error('Alignment does not match canonical narration.');
      const begin = Number(fragment.begin);
      const end = Number(fragment.end);
      if (!Number.isFinite(end) || end < begin) throw new Error('Invalid alignment word end.');
      return { begin, end };
    });
    if (
      !alignedWordTimes(input.speech, input.durationSeconds, {
        status: 'aligned',
        onsets: fragments.map(fragment => fragment.begin),
      })
    )
      throw new Error('Invalid recording word onsets.');
    const onsets = await trimRecordingSilence(input.bytes, fragments);
    input.signal.throwIfAborted();
    const alignment = { status: 'aligned' as const, onsets };
    if (!alignedWordTimes(input.speech, input.durationSeconds, alignment))
      throw new Error('Invalid recording word onsets.');
    return alignment;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
