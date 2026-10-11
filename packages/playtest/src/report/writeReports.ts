import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ObservedEvent } from '../adapter';
import type { InspectorFinding } from '../inspector/inspect';
import type { LearnerRunResult } from '../learner/loop';
import type { RunSummary, StepProbeSignal, StoryRunRecord } from '../runner';

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    character =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string
  );
}
function escapeMarkdown(text: string): string {
  return escapeHtml(text.replace(/[\\`*_{}[\]()#+.!|~:-]/g, '\\$&'));
}
function evidenceLink(from: string, path: string): string {
  return relative(from, path).split('\\').join('/').split('/').map(encodeURIComponent).join('/');
}
function findingMarkdown(finding: InspectorFinding, dir: string): string {
  return `### ${escapeMarkdown(finding.taxonomyClass)}: ${escapeMarkdown(finding.title)}\n\n${escapeMarkdown(finding.trigger)}\n\nExpected: ${escapeMarkdown(finding.expected)}\n\nActual: ${escapeMarkdown(finding.actual)}\n\nStep ${finding.stepIndex}: [Screenshot](${evidenceLink(dir, finding.screenshotPath)})`;
}

/** Raw facts and the learner trace are retained alongside the three separate report categories. */
export async function writeStoryReports(input: {
  record: StoryRunRecord;
  learner?: LearnerRunResult;
  probeSignals?: StepProbeSignal[];
  tracePath?: string;
  stopEvent?: ObservedEvent;
  inspectionError?: string;
}): Promise<void> {
  const { record, learner, tracePath, stopEvent, inspectionError } = input;
  const dir = dirname(record.reportPath);
  await mkdir(dir, { recursive: true });
  const probeFindings = record.findings.filter(finding => finding.source === 'probe');
  const judgeFindings = record.findings.filter(finding => finding.source === 'judge');
  const json = {
    ...record,
    learner,
    probeSignals: input.probeSignals ?? [],
    probeFindings,
    judgeFindings,
    tracePath,
    stopEvent,
    inspectionError,
  };
  const sections = [
    `# ${escapeMarkdown(record.storyId)} (${record.viewport})`,
    `Outcome: ${record.outcome}`,
    ...(record.elapsedMs === undefined ? [] : [`Elapsed: ${record.elapsedMs.toFixed(1)} ms`]),
    ...(record.modelUsage
      ? [
          `Model usage (Pi): ${record.modelUsage.total.totalTokens} tokens; USD ${record.modelUsage.total.cost.total.toFixed(6)}`,
        ]
      : []),
    ...(record.reason ? [escapeMarkdown(record.reason)] : []),
    ...(record.cleanupError ? [`Cleanup: ${escapeMarkdown(record.cleanupError)}`] : []),
    ...(record.correlationId ? [`Request: ${escapeMarkdown(record.correlationId)}`] : []),
    ...(stopEvent?.kind === 'response'
      ? [`Stopped response: ${stopEvent.status} ${escapeMarkdown(stopEvent.url)}`]
      : []),
    ...(tracePath ? [`[Browser trace](${evidenceLink(dir, tracePath)})`] : []),
    ...(inspectionError ? [escapeMarkdown(inspectionError)] : []),
    '## Probe findings',
    ...probeFindings.map(finding => findingMarkdown(finding, dir)),
    '## Judge findings',
    ...judgeFindings.map(finding => findingMarkdown(finding, dir)),
    '## Learner friction',
    ...record.friction.map(escapeMarkdown),
    '## Diary',
    ...(learner?.diary.map(escapeMarkdown) ?? []),
    '## Observations',
    ...(learner?.observations.map(
      observation =>
        `Step ${observation.stepIndex}: ${escapeMarkdown(observation.url)} — [Screenshot](${evidenceLink(dir, observation.screenshotPath)})`
    ) ?? []),
  ];
  await writeFile(record.reportPath, `${JSON.stringify(json, null, 2)}\n`);
  await writeFile(join(dir, 'story.md'), `${sections.join('\n\n')}\n`);
}

/** The HTML summary escapes adapter and learner text and links to local evidence reports. */
export async function writeSummaryReports(summary: RunSummary): Promise<void> {
  await mkdir(summary.runDir, { recursive: true });
  const counts = Object.entries(summary.outcomeCounts)
    .map(([outcome, count]) => `<li>${outcome}: ${count}</li>`)
    .join('');
  const rows = summary.records
    .map(record => {
      const reportDir = dirname(record.reportPath);
      const list = (findings: InspectorFinding[]) =>
        `<ul>${findings.map(finding => `<li>${escapeHtml(finding.taxonomyClass)}: ${escapeHtml(finding.title)} (step ${finding.stepIndex}, <a href="${evidenceLink(summary.runDir, finding.screenshotPath)}">screenshot</a>)</li>`).join('')}</ul>`;
      return `<tr><td><a href="${evidenceLink(summary.runDir, join(reportDir, 'story.md'))}">${escapeHtml(record.storyId)}</a> (${record.viewport})</td><td>${record.outcome}${record.reason ? `<p>${escapeHtml(record.reason)}</p>` : ''}</td><td>${record.elapsedMs?.toFixed(1) ?? 'Unavailable'}</td><td>${record.modelUsage ? `USD ${record.modelUsage.total.cost.total.toFixed(6)} (${record.modelUsage.total.totalTokens} tokens)` : 'Unavailable'}</td><td>${list(record.findings.filter(finding => finding.source === 'probe'))}</td><td>${list(record.findings.filter(finding => finding.source === 'judge'))}</td><td><ul>${record.friction.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul></td></tr>`;
    })
    .join('');
  await writeFile(join(summary.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    join(summary.runDir, 'summary.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Playtest summary</title><body><h1>Playtest summary</h1><ul>${counts}</ul><table><thead><tr><th>Story</th><th>Outcome</th><th>Elapsed (ms)</th><th>Model usage (Pi)</th><th>Probe findings</th><th>Judge findings</th><th>Learner friction</th></tr></thead><tbody>${rows}</tbody></table></body></html>\n`
  );
}
