import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

import {
  formatSourceArchiveIndex,
  SOURCE_ARCHIVE_ANALYSIS_TOOLS,
  SourceArchiveClient,
} from '../../../services/projects/sourceArchive.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

test('formatSourceArchiveIndex preserves every path and available preview in stable order', () => {
  const formatted = formatSourceArchiveIndex({
    entries: [
      {
        byteSize: 14,
        contentKind: 'text',
        kind: 'file',
        path: 'src/main.ts',
        preview: 'export const x = 1;',
      },
      { kind: 'directory', path: '.github' },
      {
        byteSize: 32,
        contentKind: 'binary',
        kind: 'file',
        path: 'assets/icon.png',
      },
    ],
  });

  assert.equal(
    formatted,
    [
      'DIRECTORY .github',
      'FILE assets/icon.png | binary | 32 bytes',
      'FILE src/main.ts | text | 14 bytes',
      'PREVIEW src/main.ts',
      'export const x = 1;',
    ].join('\n')
  );
});

test('formatSourceArchiveIndex shares a global preview budget fairly across 20k text files', () => {
  const entries = Array.from({ length: 20_000 }, (_, index) => ({
    byteSize: 100,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: `src/file-${String(index).padStart(5, '0')}.ts`,
    preview: 'preview text',
  }));
  const index = {
    entries: [{ kind: 'directory' as const, path: 'src' }, ...entries],
  };

  const formatted = formatSourceArchiveIndex(index, { previewBudgetChars: 20_000 });
  const reversed = formatSourceArchiveIndex(
    { entries: [...index.entries].reverse() },
    { previewBudgetChars: 20_000 }
  );
  const lines = formatted.split('\n');
  const previews = lines.flatMap((line, index) =>
    line.startsWith('PREVIEW ') ? [lines[index + 1] || ''] : []
  );

  assert.equal(formatted, reversed);
  assert.equal(previews.length, 20_000);
  assert.ok(previews.every(preview => preview.length === 1));
  assert.match(formatted, /DIRECTORY src/u);
  assert.match(formatted, /FILE src\/file-00000[.]ts/u);
  assert.match(formatted, /FILE src\/file-19999[.]ts/u);
});

test('formatSourceArchiveIndex rejects a budget that would starve text files', () => {
  assert.throws(
    () =>
      formatSourceArchiveIndex(
        {
          entries: [
            {
              byteSize: 10,
              contentKind: 'text',
              kind: 'file',
              path: 'a.ts',
              preview: 'a',
            },
            {
              byteSize: 10,
              contentKind: 'text',
              kind: 'file',
              path: 'b.ts',
              preview: 'b',
            },
          ],
        },
        { previewBudgetChars: 1 }
      ),
    /one character per text file/u
  );
});

test('SourceArchiveClient executes exact model tool calls through the archive query endpoint', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      result: {
        cursorBytes: 262_141,
        endByteExclusive: 262_167,
        nextCursorBytes: null,
        path: 'src/main.ts',
        text: 'export const x = 1;',
        totalBytes: 262_167,
      },
    }),
  });

  const client = new SourceArchiveClient('https://backend.test');
  const archiveVersion = {
    sourceHash: 'a'.repeat(64),
    sourceId: 'source-engine',
  };
  const result = await client.runToolCall('project/with spaces', archiveVersion, {
    id: 'tool-1',
    type: 'function',
    function: {
      name: 'read_source_file',
      arguments: '{"path":"src/main.ts","cursorBytes":262141}',
    },
  });

  assert.deepEqual(result, {
    cursorBytes: 262_141,
    endByteExclusive: 262_167,
    nextCursorBytes: null,
    path: 'src/main.ts',
    text: 'export const x = 1;',
    totalBytes: 262_167,
  });
  assert.equal(
    fetchMock.mock.calls[0]?.[0],
    'https://backend.test/api/projects/projects/project%2Fwith%20spaces/source/archive/query'
  );
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
  assert.deepEqual(body, {
    archiveVersion,
    cursorBytes: 262_141,
    operation: 'read-file',
    path: 'src/main.ts',
  });
  assert.equal(
    (SOURCE_ARCHIVE_ANALYSIS_TOOLS[0] as { function?: { name?: string } }).function?.name,
    'list_source_directory'
  );
  const readTool = SOURCE_ARCHIVE_ANALYSIS_TOOLS.find(
    tool => (tool as { function?: { name?: string } }).function?.name === 'read_source_file'
  ) as {
    function: {
      parameters: {
        properties: { cursorBytes?: { minimum?: number; type?: string } };
      };
    };
  };
  assert.deepEqual(readTool.function.parameters.properties.cursorBytes, {
    minimum: 0,
    type: 'integer',
  });
});

test('SourceArchiveClient rejects unsupported operations instead of guessing model intent', async () => {
  const client = new SourceArchiveClient('https://backend.test');

  await assert.rejects(
    () =>
      client.runToolCall(
        'project-1',
        {
          sourceHash: 'a'.repeat(64),
          sourceId: 'source-engine',
        },
        {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'summarize_source',
            arguments: '{}',
          },
        }
      ),
    /Operazione tool sorgente non supportata/
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('SourceArchiveClient rejects invalid read cursors before querying the backend', async () => {
  const client = new SourceArchiveClient('https://backend.test');
  const archiveVersion = {
    sourceHash: 'a'.repeat(64),
    sourceId: 'source-engine',
  };

  for (const cursorBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () =>
        client.runToolCall('project-1', archiveVersion, {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'read_source_file',
            arguments: JSON.stringify({ cursorBytes, path: 'src/main.ts' }),
          },
        }),
      /cursorBytes/u
    );
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});
