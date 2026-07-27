import { useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { MotionDialog, Pressable } from '../../utils/motion/index.ts';

interface CourseGenerationNotesDialogProps {
  readonly courseTitle: string;
  readonly initialValue: string;
  readonly onSaveAndContinue: (notes: string) => void;
  readonly onSkip: () => void;
}

export default function CourseGenerationNotesDialog({
  courseTitle,
  initialValue,
  onSaveAndContinue,
  onSkip,
}: CourseGenerationNotesDialogProps) {
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const trimmed = value.trim();

  return (
    <MotionDialog
      isOpen
      contentClassName="w-full max-w-xl rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-zinc-500/60 dark:bg-stone-700"
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
        {t('Come vuoi che siano le lezioni di "{courseTitle}"?', { courseTitle })}
      </h2>
      <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-zinc-300">
        {t(
          'Prima di generare la prima lezione, puoi dare al professore delle indicazioni specifiche per questo corso: tono, livello di dettaglio, cose da evitare, cose da spiegare con più calma. Queste note hanno priorita sullo stile di default.'
        )}
      </p>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={event => setValue(event.target.value)}
        placeholder={t(
          'Es. Sono a disagio con la matematica. Quando introduci una formula, spiega ogni simbolo e fai un esempio numerico prima di andare avanti.'
        )}
        rows={6}
        className="mt-4 w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-500/60 dark:bg-stone-800 dark:text-white dark:focus:border-zinc-400"
      />
      <p className="mt-2 text-xs text-gray-500 dark:text-zinc-400">
        {t('Potrai modificare queste note in qualsiasi momento dalle impostazioni del corso.')}
      </p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Pressable
          onClick={onSkip}
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-zinc-500/60 dark:text-zinc-200 dark:hover:bg-stone-600"
        >
          {t('Genera senza note')}
        </Pressable>
        <Pressable
          onClick={() => onSaveAndContinue(trimmed)}
          disabled={trimmed.length === 0}
          className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-200 dark:text-stone-900 dark:hover:bg-white"
        >
          {t('Salva note e genera')}
        </Pressable>
      </div>
    </MotionDialog>
  );
}
