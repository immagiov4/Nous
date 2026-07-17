import { ChevronDown, type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

interface AdminDisclosureProps {
  children: ReactNode;
  defaultOpen?: boolean;
  icon: LucideIcon;
  status: string;
  title: string;
}

export default function AdminDisclosure({
  children,
  defaultOpen = false,
  icon: Icon,
  status,
  title,
}: AdminDisclosureProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <details
      open={isOpen}
      onToggle={event => setIsOpen(event.currentTarget.open)}
      className="group border-b border-stone-200 last:border-b-0 dark:border-zinc-700"
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 sm:px-5 dark:hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
        <Icon className="h-5 w-5 shrink-0 text-stone-500 dark:text-zinc-400" />
        <span className="min-w-0 flex-1 font-serif text-lg text-stone-950 dark:text-zinc-100">
          {title}
        </span>
        <span className="truncate text-xs text-stone-500 dark:text-zinc-400">{status}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="border-t border-stone-100 px-4 py-5 sm:px-5 dark:border-zinc-800">
        {children}
      </div>
    </details>
  );
}
