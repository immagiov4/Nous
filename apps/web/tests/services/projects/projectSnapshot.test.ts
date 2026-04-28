import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CURRENT_LABORATORY_SCHEMA_VERSION } from '../../../services/laboratory/state.ts';
import {
  buildCoverLabel,
  exportProjectData,
  inferProjectSourceKind,
  normalizeImportedProject,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  decodeTextBase64,
  encodeTextBase64,
  getProjectSourceFile,
} from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

test('createProjectSourceFromFile upgrades legacy zip payloads into structured codebase sources', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('--- START OF FILE: src/index.ts ---\nconsole.log("hi");'),
  });

  assert.equal(source.kind, 'codebase-bundle');
  assert.match(source.aggregatedText, /src\/index\.ts/);
});

test('getProjectSourceFile preserves a round-trip legacy file payload for codebase bundles', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  const file = getProjectSourceFile(source);

  assert.equal(file?.name, 'repo.zip');
  assert.equal(file?.mimeType, 'text/plain');
  assert.equal(decodeTextBase64(file?.data || ''), 'console.log("hi");');
});

test('inferProjectSourceKind treats single text files as documents', () => {
  const source = createProjectSourceFromFile({
    name: 'notes.md',
    mimeType: 'text/markdown',
    data: encodeTextBase64('# Notes'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'document');
  assert.equal(
    buildCoverLabel(
      { source, learningPlan: null, laboratory: null, isLearnMode: false },
      'document'
    ),
    'notes.md'
  );
});

test('inferProjectSourceKind keeps zip-backed codebase bundles as codebase projects', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'codebase');
});

test('exportProjectData keeps the source only once for modern exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: {
      kind: 'pdf',
      file: pdfFile,
    },
    learningPlan: null,
    laboratory: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: null,
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastOpenedAt: '2026-04-03T00:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const exported = exportProjectData(snapshot);

  assert.deepEqual(exported.source, snapshot.source);
  assert.equal(Object.hasOwn(exported, 'file'), false);
});

test('normalizeImportedProject still supports legacy file-only exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };

  const imported = normalizeImportedProject({
    version: '3.0',
    file: pdfFile,
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.deepEqual(imported.source, {
    kind: 'pdf',
    file: pdfFile,
  });
});

test('exportProjectData preserves laboratory data and the active laboratory exercise', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-lab',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: null,
    laboratory: {
      exercises: [
        {
          attachments: [
            {
              id: 'attachment-1',
              name: 'answer.md',
              mimeType: 'text/markdown',
              kind: 'text',
              data: encodeTextBase64('# Risposta'),
              createdAt: '2026-04-03T00:00:00.000Z',
              updatedAt: '2026-04-03T00:00:00.000Z',
            },
          ],
          approachMarkdown: '## Metodo\n\nParti dal runtime e annota i vincoli.',
          brief: 'Scrivi una procedura.',
          evaluation: {
            caveats: ['Serve comunque verifica locale.'],
            confidenceScore: 62,
            confidenceSummary: 'La valutazione e indicativa su alcuni aspetti pratici.',
            evaluatedAt: '2026-04-03T00:00:00.000Z',
            improvements: ['Aggiungi evidenze di output.'],
            score: 78,
            strengths: ['Buona struttura.'],
            summary: 'Elaborato nel complesso solido.',
          },
          exampleMarkdown:
            '## Esempio guidato\n\nSu un servizio parallelo, verifica prima input, output e log osservabili.',
          generatedAt: '2026-04-03T00:00:00.000Z',
          id: 'exercise-1',
          internalNotes: ['Richiede verifica manuale del runtime.'],
          instructionsMarkdown: '## Traccia',
          requirements: [
            'Usa il caso assegnato senza cambiarlo.',
            'Descrivi almeno una evidenza tecnica concreta.',
            'Proponi una procedura verificabile.',
          ],
          title: 'Esercizio 1',
          updatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
      generatedAt: '2026-04-03T00:00:00.000Z',
      schemaVersion: CURRENT_LABORATORY_SCHEMA_VERSION,
      status: 'ready',
      summary: 'Laboratorio finale',
      title: 'Laboratorio',
      updatedAt: '2026-04-03T00:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: 'exercise-1',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastOpenedAt: '2026-04-03T00:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const exported = exportProjectData(snapshot);

  assert.equal(exported.laboratory?.exercises.length, 1);
  assert.equal(exported.activeLaboratoryExerciseId, 'exercise-1');
  assert.equal(exported.laboratory?.exercises[0]?.attachments[0]?.name, 'answer.md');
});

test('normalizeImportedProject restores modern laboratory payloads', () => {
  const imported = normalizeImportedProject({
    version: '4.1',
    learningPlan: null,
    laboratory: {
      exercises: [
        {
          attachments: [
            {
              id: 'attachment-1',
              name: 'notes.md',
              mimeType: 'text/markdown',
              kind: 'text',
              data: encodeTextBase64('# Note'),
              createdAt: '2026-04-03T00:00:00.000Z',
              updatedAt: '2026-04-03T00:00:00.000Z',
            },
          ],
          approachMarkdown: '## Metodo\n\nParti dai requisiti e costruisci una checklist.',
          brief: 'Breve traccia',
          evaluation: null,
          exampleMarkdown:
            '## Esempio guidato\n\nSu un caso simile, elenca prima i vincoli e poi il primo artefatto da produrre.',
          generatedAt: '2026-04-03T00:00:00.000Z',
          id: 'exercise-1',
          internalNotes: ['Nota interna'],
          instructionsMarkdown: '## Traccia',
          requirements: [
            'Lavora sul contesto gia assegnato.',
            'Produci un elaborato verificabile.',
            'Motiva le scelte con evidenze.',
          ],
          title: 'Esercizio',
          updatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
      schemaVersion: CURRENT_LABORATORY_SCHEMA_VERSION,
      status: 'ready',
      summary: 'Laboratorio',
      title: 'Laboratorio',
      updatedAt: '2026-04-03T00:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeLaboratoryExerciseId: 'exercise-1',
  });

  assert.equal(imported.laboratory?.exercises[0]?.attachments.length, 1);
  assert.equal(imported.activeLaboratoryExerciseId, 'exercise-1');
  assert.equal(imported.laboratory?.schemaVersion, CURRENT_LABORATORY_SCHEMA_VERSION);
  assert.equal(imported.laboratory?.exercises[0]?.requirements.length, 3);
});
