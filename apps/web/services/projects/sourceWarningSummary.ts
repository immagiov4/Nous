import type { SourceArchivePdfWarningReason } from '@shared/sourceArchiveWarnings';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { ProjectSourceWarning } from '../../types.ts';

const DISPLAY_PATH_LIMIT = 80;
const REPRESENTATIVE_PATH_LIMIT = 3;
const warningReasonOrder: SourceArchivePdfWarningReason[] = [
  'no-usable-text',
  'parser-failed',
  'safety-limit',
  'timeout',
];

const compareNames = (left: ProjectSourceWarning, right: ProjectSourceWarning): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const elidePath = (path: string): string => {
  if (path.length <= DISPLAY_PATH_LIMIT) return path;
  const visibleCharacters = DISPLAY_PATH_LIMIT - 1;
  const prefixLength = Math.ceil(visibleCharacters / 2);
  return `${path.slice(0, prefixLength)}…${path.slice(path.length - (visibleCharacters - prefixLength))}`;
};

const formatReasonCount = (reason: SourceArchivePdfWarningReason, count: number): string => {
  switch (reason) {
    case 'no-usable-text':
      return t('{count} senza testo utile', { count });
    case 'parser-failed':
      return t('{count} non leggibili', { count });
    case 'safety-limit':
      return t('{count} oltre i limiti', { count });
    case 'timeout':
      return t('{count} scaduti', { count });
  }
};

export const formatSourceWarningSummary = (
  warnings: readonly ProjectSourceWarning[],
  { continues = true }: { continues?: boolean } = {}
): string => {
  const pdfWarnings = warnings.filter(
    (warning): warning is ProjectSourceWarning & { reason: SourceArchivePdfWarningReason } =>
      warning.reason !== undefined
  );
  if (pdfWarnings.length === 0) {
    const sourceNames = warnings.map(warning => warning.name).join(', ');
    return continues
      ? t('Alcune fonti non sono state usate: {sourceNames}. Il corso continua con le altre.', {
          sourceNames,
        })
      : t('Alcune fonti non sono state usate: {sourceNames}.', { sourceNames });
  }

  const sortedPdfWarnings = [...pdfWarnings].sort(compareNames);
  const reasonCounts = new Map<SourceArchivePdfWarningReason, number>();
  for (const warning of sortedPdfWarnings) {
    reasonCounts.set(warning.reason, (reasonCounts.get(warning.reason) || 0) + 1);
  }
  const reasons = warningReasonOrder
    .flatMap(reason => {
      const count = reasonCounts.get(reason);
      return count ? [formatReasonCount(reason, count)] : [];
    })
    .join(', ');
  const paths = sortedPdfWarnings
    .slice(0, REPRESENTATIVE_PATH_LIMIT)
    .map(warning => elidePath(warning.name))
    .join('; ');
  const hiddenCount = sortedPdfWarnings.length - REPRESENTATIVE_PATH_LIMIT;
  const hidden =
    hiddenCount > 0 ? ` ${t('Altri {count} non mostrati.', { count: hiddenCount })}` : '';
  const otherWarnings = warnings.filter(warning => warning.reason === undefined);
  const other =
    otherWarnings.length > 0
      ? ` ${t('Altre fonti non usate: {sourceNames}.', {
          sourceNames: otherWarnings.map(warning => warning.name).join(', '),
        })}`
      : '';

  const continuation = continues ? ` ${t('Il corso continua con le fonti valide.')}` : '';
  return `${t('{count} PDF non usati: {reasons}. Esempi: {paths}.', {
    count: sortedPdfWarnings.length,
    paths,
    reasons,
  })}${hidden}${other}${continuation}`;
};
