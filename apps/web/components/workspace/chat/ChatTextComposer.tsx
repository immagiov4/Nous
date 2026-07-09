import { ArrowUp, LoaderCircle } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';

interface ChatTextComposerProps {
  className?: string;
  disabled?: boolean;
  leadingContent?: ReactNode;
  inputClassName?: string;
  inputShellClassName?: string;
  isLoading?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitAriaLabel?: string;
  submitButtonClassName?: string;
  submitContent?: ReactNode;
  submitTitle?: string;
  trailingContent?: ReactNode;
  value: string;
}

export default function ChatTextComposer({
  className,
  disabled = false,
  leadingContent,
  inputClassName,
  inputShellClassName,
  isLoading = false,
  onChange,
  onSubmit,
  placeholder,
  submitAriaLabel,
  submitButtonClassName,
  submitContent,
  submitTitle,
  trailingContent,
  value,
}: ChatTextComposerProps) {
  const trimmedValue = value.trim();
  const isSubmitDisabled = disabled || isLoading || trimmedValue.length === 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isSubmitDisabled) {
      return;
    }

    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className={className}>
      {leadingContent}

      <div
        className={
          inputShellClassName ||
          'min-w-0 flex-1 rounded-full border border-stone-200/70 bg-white px-3 py-2 dark:border-stone-500/80 dark:bg-stone-800'
        }
      >
        <input
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={
            inputClassName ||
            'h-10 w-full min-w-0 border-0 bg-transparent px-1 text-sm text-stone-800 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-400'
          }
        />
      </div>

      {trailingContent}

      <button
        type="submit"
        aria-label={submitAriaLabel || submitTitle || 'Invia messaggio'}
        title={submitTitle || 'Invia messaggio'}
        disabled={isSubmitDisabled}
        className={
          submitButtonClassName ||
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-900 text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500'
        }
      >
        {isLoading ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          submitContent || <ArrowUp className="h-4 w-4" />
        )}
      </button>
    </form>
  );
}
