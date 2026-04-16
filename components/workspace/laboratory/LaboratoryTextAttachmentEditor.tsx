import { Bold, Code2, Eye, EyeOff, Heading2, List, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readLaboratoryTextAttachment } from '../../../services/laboratory/attachments.ts';
import type { LaboratoryAttachment } from '../../../types.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';

interface LaboratoryTextAttachmentEditorProps {
  attachment: LaboratoryAttachment;
  isDarkMode: boolean;
  onRemove: (attachmentId: string) => void;
  onUpdate: (attachmentId: string, updates: { content: string; name?: string }) => void;
}

const TOOLBAR_BUTTON_CLASS_NAME =
  'inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200/80 bg-white text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white';

const applySelectionTransform = (
  textarea: HTMLTextAreaElement,
  currentValue: string,
  transform: (selectedText: string) => {
    nextText: string;
    nextSelectionEnd: number;
    nextSelectionStart: number;
  }
) => {
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const selectedText = currentValue.slice(selectionStart, selectionEnd);
  return transform(selectedText);
};

export default function LaboratoryTextAttachmentEditor({
  attachment,
  isDarkMode,
  onRemove,
  onUpdate,
}: LaboratoryTextAttachmentEditorProps) {
  const sourceContent = useMemo(() => readLaboratoryTextAttachment(attachment), [attachment]);
  const [draftName, setDraftName] = useState(attachment.name);
  const [draftContent, setDraftContent] = useState(sourceContent);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraftName(attachment.name);
  }, [attachment.name]);

  useEffect(() => {
    setDraftContent(sourceContent);
  }, [sourceContent]);

  useEffect(() => {
    const normalizedName = draftName.trim() || attachment.name;
    if (normalizedName === attachment.name && draftContent === sourceContent) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      onUpdate(attachment.id, {
        content: draftContent,
        name: normalizedName,
      });
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [attachment.id, attachment.name, draftContent, draftName, onUpdate, sourceContent]);

  const withTextareaTransform = (
    transform: (selectedText: string) => {
      nextText: string;
      nextSelectionEnd: number;
      nextSelectionStart: number;
    }
  ) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const result = applySelectionTransform(textarea, draftContent, transform);
    setDraftContent(result.nextText);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd);
    });
  };

  return (
    <article className="overflow-hidden rounded-xl border border-gray-200/80 bg-white/90 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
      <header className="space-y-2 border-b border-gray-200/80 px-4 py-4 dark:border-zinc-700/80">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={draftName}
            onChange={event => setDraftName(event.target.value)}
            placeholder="Nome allegato"
            className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            title="Rimuovi allegato"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform(selectedText => {
                const replacement = `## ${selectedText || 'Titolo sezione'}`;
                const nextText = `${draftContent.slice(0, textareaRef.current?.selectionStart || 0)}${replacement}${draftContent.slice(textareaRef.current?.selectionEnd || 0)}`;
                const nextSelectionStart =
                  (textareaRef.current?.selectionStart || 0) + replacement.length;
                return {
                  nextText,
                  nextSelectionEnd: nextSelectionStart,
                  nextSelectionStart,
                };
              })
            }
            title="Inserisci heading"
          >
            <Heading2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform(selectedText => {
                const replacement = `**${selectedText || 'testo'}**`;
                const start = textareaRef.current?.selectionStart || 0;
                return {
                  nextText: `${draftContent.slice(0, start)}${replacement}${draftContent.slice(textareaRef.current?.selectionEnd || 0)}`,
                  nextSelectionStart: start + 2,
                  nextSelectionEnd: start + replacement.length - 2,
                };
              })
            }
            title="Grassetto"
          >
            <Bold className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform(selectedText => {
                const start = textareaRef.current?.selectionStart || 0;
                const selection = selectedText || 'voce lista';
                const replacement = selection
                  .split(/\n/)
                  .map(line => `- ${line}`)
                  .join('\n');
                return {
                  nextText: `${draftContent.slice(0, start)}${replacement}${draftContent.slice(textareaRef.current?.selectionEnd || 0)}`,
                  nextSelectionStart: start,
                  nextSelectionEnd: start + replacement.length,
                };
              })
            }
            title="Lista"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform(selectedText => {
                const start = textareaRef.current?.selectionStart || 0;
                const replacement = `\n\`\`\`\n${selectedText || 'codice'}\n\`\`\`\n`;
                return {
                  nextText: `${draftContent.slice(0, start)}${replacement}${draftContent.slice(textareaRef.current?.selectionEnd || 0)}`,
                  nextSelectionStart: start + 5,
                  nextSelectionEnd: start + replacement.length - 5,
                };
              })
            }
            title="Blocco codice"
          >
            <Code2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() => setIsPreviewOpen(currentValue => !currentValue)}
            title={isPreviewOpen ? 'Chiudi anteprima' : 'Apri anteprima'}
          >
            {isPreviewOpen ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <div className="px-4 py-4">
        {isPreviewOpen ? (
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/80 px-5 py-5 dark:border-zinc-700 dark:bg-zinc-950/70">
            <MarkdownRenderer
              content={draftContent || '_Anteprima vuota_'}
              isDarkMode={isDarkMode}
              className={
                isDarkMode ? 'prose-invert prose-sm sm:prose-base' : 'prose-sm sm:prose-base'
              }
            />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={draftContent}
            onChange={event => setDraftContent(event.target.value)}
            spellCheck={false}
            className="min-h-[17rem] w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-4 font-mono text-sm leading-6 text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-700 dark:bg-zinc-950/80 dark:text-zinc-100 dark:focus:border-zinc-500"
            placeholder="Scrivi qui la tua consegna in Markdown o testo libero."
          />
        )}
      </div>
    </article>
  );
}
