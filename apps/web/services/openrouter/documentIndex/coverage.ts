import type {
  LearningPlan,
  LessonNode,
  PdfTextChunk,
  PdfTextIndex,
  PdfTextPage,
} from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { timestampIso } from '../../../utils/time.ts';
import { pushNousDebugTrace } from '../../core/debugTrace.ts';
import {
  compressPagesToGaps,
  expandPageRange,
  formatPageRange,
  logPdfPlanDebug,
  resolvePdfPlanSubstantiveRange,
} from './chunking.ts';
import { buildPdfPageTextLayout, resolvePdfChunkPageSpan } from './layout.ts';

type PageRangeSource = 'exact' | 'estimated' | 'mixed' | 'missing';

interface PdfPlanLessonCoverage {
  lessonId: string;
  title: string;
  type: LessonNode['type'];
  chunkCount: number;
  chunkIds: string[];
  coveredPageCount: number;
  coveredPages: number[];
  flags: string[];
  pageRange: string | null;
  pageRangeLength: number;
  pageRangeSource: PageRangeSource;
}

interface PdfPlanPageGap {
  endPage: number;
  pageCount: number;
  startPage: number;
}

interface PdfPlanCoverageReport {
  coveredSubstantivePages: number;
  coverageRatio: number;
  gapCount: number;
  gaps: PdfPlanPageGap[];
  lessonCount: number;
  lessonSpans: PdfPlanLessonCoverage[];
  mappedLessonCount: number;
  mappingSource: 'fallback' | 'mapped';
  missingLessonCount: number;
  pageCount: number;
  parser: 'pdftotext' | 'pdf-parse' | 'unknown';
  substantiveRange: { endPage: number; pageCount: number; startPage: number };
  warnings: string[];
}

const buildPdfPlanCoverageReport = (
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  pageCount: number,
  pdfPages: PdfTextPage[] | undefined,
  parser: 'pdftotext' | 'pdf-parse' | undefined,
  mappingSource: 'fallback' | 'mapped'
): PdfPlanCoverageReport => {
  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));

  const lessonSpans = flattenLessons(plan.modules)
    .filter(lesson => lesson.type !== 'summary')
    .map(lesson => {
      const primaryChunks = (lesson.primaryChunkIds || [])
        .map(chunkId => indexById.get(chunkId))
        .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
      const chunkSpans = primaryChunks
        .map(chunk => resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout))
        .filter(
          (
            span
          ): span is {
            startPage: number;
            endPage: number;
            exact: boolean;
          } => Boolean(span)
        );

      if (chunkSpans.length === 0) {
        return {
          lessonId: lesson.id,
          title: lesson.title,
          type: lesson.type,
          chunkCount: primaryChunks.length,
          chunkIds: primaryChunks.map(chunk => chunk.id),
          coveredPageCount: 0,
          coveredPages: [] as number[],
          flags: ['missing-mapping'],
          pageRange: null,
          pageRangeLength: 0,
          pageRangeSource: 'missing' as const,
        } satisfies PdfPlanLessonCoverage;
      }

      const allSpansAreExact = chunkSpans.every(span => span.exact);
      const someSpansAreExact = chunkSpans.some(span => span.exact);
      const coveredPages: number[] = Array.from(
        new Set(chunkSpans.flatMap(span => expandPageRange(span.startPage, span.endPage)))
      ).sort((left, right) => left - right);
      const startPage = coveredPages[0];
      const endPage = coveredPages.at(-1) as number;
      const pageRangeLength = endPage - startPage + 1;
      const coveredPageCount = coveredPages.length;
      const flags: string[] = [];
      let pageRangeSource: PdfPlanLessonCoverage['pageRangeSource'] = 'estimated';

      if (allSpansAreExact) {
        pageRangeSource = 'exact';
      } else if (someSpansAreExact) {
        pageRangeSource = 'mixed';
      }

      return {
        lessonId: lesson.id,
        title: lesson.title,
        type: lesson.type,
        chunkCount: primaryChunks.length,
        chunkIds: primaryChunks.map(chunk => chunk.id),
        coveredPageCount,
        coveredPages,
        flags,
        pageRange: formatPageRange(startPage, endPage),
        pageRangeLength,
        pageRangeSource,
      } satisfies PdfPlanLessonCoverage;
    });

  const substantiveRange = resolvePdfPlanSubstantiveRange(pageCount);
  const substantivePages = expandPageRange(substantiveRange.startPage, substantiveRange.endPage);
  const coveredSubstantivePages = new Set<number>();

  lessonSpans.forEach(lesson => {
    lesson.coveredPages.forEach(page => {
      if (page >= substantiveRange.startPage && page <= substantiveRange.endPage) {
        coveredSubstantivePages.add(page);
      }
    });
  });

  const uncoveredSubstantivePages = substantivePages.filter(
    page => !coveredSubstantivePages.has(page)
  );
  const gaps = compressPagesToGaps(uncoveredSubstantivePages);
  const coverageRatio =
    substantiveRange.pageCount > 0 ? coveredSubstantivePages.size / substantiveRange.pageCount : 1;

  const missingLessons = lessonSpans.filter(lesson => lesson.flags.includes('missing-mapping'));
  const warnings: string[] = [];

  if (missingLessons.length > 0) {
    warnings.push(
      `${missingLessons.length} lezioni non hanno chunk primari risolti dopo il mapping.`
    );
  }

  return {
    coveredSubstantivePages: coveredSubstantivePages.size,
    coverageRatio: Number.parseFloat(coverageRatio.toFixed(4)),
    gapCount: gaps.length,
    gaps,
    lessonCount: lessonSpans.length,
    lessonSpans,
    mappedLessonCount: lessonSpans.filter(lesson => lesson.pageRange).length,
    mappingSource,
    missingLessonCount: missingLessons.length,
    pageCount,
    parser: parser || 'unknown',
    substantiveRange,
    warnings,
  };
};

export const emitPdfPlanCoverageDiagnostics = (
  fileName: string,
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  pdfSession:
    | {
        pages?: PdfTextPage[];
        pageCount?: number;
        parser?: 'pdftotext' | 'pdf-parse';
      }
    | null
    | undefined,
  mappingSource: 'fallback' | 'mapped'
): PdfPlanCoverageReport | null => {
  const pageCount = pdfSession?.pageCount || documentIndex.pageCount;
  if (!pageCount || pageCount < 1) {
    return null;
  }

  const report = buildPdfPlanCoverageReport(
    plan,
    documentIndex,
    pageCount,
    pdfSession?.pages,
    pdfSession?.parser,
    mappingSource
  );
  const payload = {
    fileName,
    ...report,
  };

  logPdfPlanDebug('Coverage summary', payload);
  pushNousDebugTrace('pdf-plan:coverage', payload);

  if (report.warnings.length > 0) {
    logPdfPlanDebug('Coverage warnings', {
      fileName,
      warningCount: report.warnings.length,
      warnings: report.warnings,
    });
    pushNousDebugTrace('pdf-plan:coverage-warning', {
      fileName,
      warningCount: report.warnings.length,
      warnings: report.warnings,
      coverageRatio: report.coverageRatio,
      gapCount: report.gapCount,
      mappingSource: report.mappingSource,
    });
  }

  return report;
};

export const applyPdfMappingQuality = (
  documentIndex: PdfTextIndex,
  report: PdfPlanCoverageReport | null
): PdfTextIndex => {
  if (!report) {
    return documentIndex;
  }

  return {
    ...documentIndex,
    mappingQuality: {
      coverageRatio: report.coverageRatio,
      gapCount: report.gapCount,
      lessonCount: report.lessonCount,
      mappedLessonCount: report.mappedLessonCount,
      mappingSource: report.mappingSource,
      updatedAt: timestampIso(),
    },
    mappingWarnings: report.warnings,
  };
};
