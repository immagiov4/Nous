import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type RunManifest, withRunEvidence } from '../../../../scripts/run-evidence.js';
import {
  buildCodexAppServerCommand,
  buildCodexAppServerEnvironment,
  type CodexAppServerError,
  CodexJsonRpcClient,
  listCodexModels,
  normalizeCodexReasoningEffort,
  readCodexAccount,
  runCodexAppServerTurn,
  runCodexAppServerTurnWithClient,
  startCodexAppServerClient,
  withSettledCodexUsage,
} from '../../src/services/codexAppServer.js';
import { type ModelExchange, withModelExchanges } from '../../src/workflows/modelExchanges.js';
import { runWithWorkflowAttemptMetering } from '../../src/workflows/workflowAiMetering.js';

vi.mock('../../../../scripts/git-identity.js', () => ({
  readGitIdentity: () => ({ commitSha: 'fixture-commit', dirty: false }),
}));

type WireMessage = Record<string, unknown>;

class FakeCodexProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly received: WireMessage[] = [];
  #buffer = '';

  constructor(private readonly onMessage: (message: WireMessage) => void) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', chunk => {
      this.#buffer += String(chunk);
      let lineEnd = this.#buffer.indexOf('\n');
      while (lineEnd >= 0) {
        const line = this.#buffer.slice(0, lineEnd);
        this.#buffer = this.#buffer.slice(lineEnd + 1);
        if (line.trim()) {
          const message = JSON.parse(line) as WireMessage;
          this.received.push(message);
          this.onMessage(message);
        }
        lineEnd = this.#buffer.indexOf('\n');
      }
    });
  }

  send(message: WireMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const stubCodexSpawn = (process: FakeCodexProcess) => {
  if (!globalThis.Bun) vi.stubGlobal('Bun', { spawn: vi.fn() });
  return vi.spyOn(Bun, 'spawn').mockReturnValue({
    stdin: process.stdin,
    stdout: Readable.toWeb(process.stdout),
    stderr: Readable.toWeb(process.stderr),
    exited: new Promise(() => {}),
    kill: process.kill,
  } as never);
};

const respond = (process: FakeCodexProcess, request: WireMessage, result: unknown): void => {
  process.send({ id: request.id, result });
};

const sendInterruptedTurnCompletion = (
  process: FakeCodexProcess,
  ids: { threadId: string; turnId: string },
  usage: {
    cacheReadTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }
): void => {
  const tokenUsage = {
    cachedInputTokens: usage.cacheReadTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
  process.send({
    method: 'thread/tokenUsage/updated',
    params: {
      ...ids,
      tokenUsage: { last: tokenUsage, modelContextWindow: 100_000, total: tokenUsage },
    },
  });
  process.send({
    method: 'turn/completed',
    params: {
      threadId: ids.threadId,
      turn: { id: ids.turnId, status: 'interrupted' },
    },
  });
};

describe('Codex app-server protocol client', () => {
  beforeEach(() => {
    process.env.CODEX_APP_SERVER_ENABLED = 'true';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CODEX_APP_SERVER_ENABLED;
  });

  test('recognizes parser rejection at every stderr chunk boundary and cleans up immediately', async () => {
    const marker = 'Failed to deserialize JSONRPCMessage';
    vi.useFakeTimers();
    for (let split = 0; split <= marker.length; split += 1) {
      const process = new FakeCodexProcess(() => undefined);
      const client = new CodexJsonRpcClient(process);
      try {
        const pending = client.request('turn/start');
        process.stderr.write('PRIVATE_SOURCE'.repeat(marker.length));
        process.stderr.write(marker.slice(0, split));
        process.stderr.write(`${marker.slice(split)}: PRIVATE_SECRET\n`);
        await expect(pending).rejects.toMatchObject({
          code: 'protocol',
          cause: { code: 'jsonrpc_deserialization_failed' },
        });
        expect(process.kill).toHaveBeenCalledTimes(1);
        expect(process.stderr.listenerCount('data')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        client.close();
      }
    }
  });

  test('handles a parser rejection delivered by a real subprocess stderr pipe', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      process.stdin.once('data', () => {
        process.stderr.write('Failed to deserialize JSONRPCMessage: PRIVATE_SOURCE\\n');
      });
    `,
      ],
      { stdio: 'pipe', windowsHide: true }
    );
    const client = new CodexJsonRpcClient(child);
    try {
      await expect(client.request('turn/start')).rejects.toMatchObject({
        code: 'protocol',
        cause: { code: 'jsonrpc_deserialization_failed' },
      });
      expect(child.stdin.writableEnded).toBe(true);
    } finally {
      client.close();
    }
  });

  test.each([
    'turn/start',
    'source-reply',
  ])('settles a turn when the parser rejects %s', async rejectedMessage => {
    vi.useFakeTimers();
    const fakeProcess = new FakeCodexProcess(message => {
      if (message.method === rejectedMessage || message.id === rejectedMessage) {
        fakeProcess.stderr.write('Failed to deserialize JSONRPCMessage: PRIVATE_SOURCE\n');
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, { account: { type: 'chatgpt' } });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'thread-parser' } });
      } else if (message.method === 'turn/start') {
        respond(fakeProcess, message, { turn: { id: 'turn-parser' } });
        queueMicrotask(() =>
          fakeProcess.send({
            id: 'source-reply',
            method: 'item/tool/call',
            params: {
              threadId: 'thread-parser',
              tool: 'read_source_file',
              callId: 'source-call',
              arguments: {},
            },
          })
        );
      }
    });
    const client = new CodexJsonRpcClient(fakeProcess);
    let failure: unknown;
    const result = runCodexAppServerTurnWithClient(
      {
        model: 'test-model',
        reasoningEffort: 'low',
        developerInstructions: 'Read source.',
        input: [{ type: 'text', text: 'Read source.' }],
        tools: [
          {
            name: 'read_source_file',
            description: 'Read source.',
            inputSchema: { type: 'object' },
            execute: async () => ({ text: 'PRIVATE_SOURCE' }),
          },
        ],
      },
      client
    ).catch(error => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(failure).toMatchObject({
        code: 'protocol',
        cause: { code: 'jsonrpc_deserialization_failed' },
      });
      await result;
      expect(vi.getTimerCount()).toBe(0);
      expect(fakeProcess.kill).toHaveBeenCalledTimes(1);
      expect(fakeProcess.received.some(message => message.method === 'turn/interrupt')).toBe(false);
    } finally {
      client.close();
    }
  });

  test.each([
    'success',
    'failure',
  ])('settles a late tool %s after parser closure', async outcome => {
    const fakeProcess = new FakeCodexProcess(() => undefined);
    const client = new CodexJsonRpcClient(fakeProcess);
    let settleTool: () => void = () => undefined;
    const toolResult = new Promise<unknown>((resolve, reject) => {
      settleTool = () =>
        outcome === 'success' ? resolve({ text: 'source' }) : reject(new Error('tool failed'));
    });
    const execute = vi.fn(() => toolResult);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.handleServerRequests(execute);
    try {
      fakeProcess.send({ id: 'slow-source', method: 'item/tool/call', params: {} });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const pending = client.request('test/ping');
      fakeProcess.stderr.write('Failed to deserialize JSONRPCMessage\n');
      await expect(pending).rejects.toMatchObject({ code: 'protocol' });
      settleTool();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(fakeProcess.received).toHaveLength(1);
      expect(fakeProcess.received[0].method).toBe('test/ping');
      expect(fakeProcess.kill).toHaveBeenCalledTimes(1);
      if (outcome === 'failure') expect(log).toHaveBeenCalledOnce();
      else expect(log).not.toHaveBeenCalled();
    } finally {
      settleTool();
      client.close();
      log.mockRestore();
    }
  });

  test('keeps the parser exception behind an invalid JSON protocol error', async () => {
    const process = new FakeCodexProcess(() => undefined);
    const client = new CodexJsonRpcClient(process);
    try {
      const pending = client.request('test/ping');
      process.stdout.write('not-json\n');
      const error = await pending.catch(reason => reason);
      expect(error).toMatchObject({ code: 'protocol', cause: expect.any(SyntaxError) });
    } finally {
      client.close();
    }
  });
  test('logs a redacted client-tool handler error while returning only a safe protocol error', async () => {
    const process = new FakeCodexProcess(() => undefined);
    const client = new CodexJsonRpcClient(process);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      client.handleServerRequests(async () => {
        throw new Error('tool rejected token=private');
      });
      process.send({ id: 99, method: 'item/tool/call', params: {} });
      await vi.waitFor(() => expect(process.received).toHaveLength(1));
      expect(JSON.stringify(process.received[0])).not.toContain('private');
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.any(String),
            expect.objectContaining({
              diagnostic: expect.objectContaining({
                originalMessage: 'tool rejected token=[REDACTED]',
              }),
            }),
          ]),
        ])
      );
    } finally {
      log.mockRestore();
      client.close();
    }
  });
  test('normalizes unsupported zero-effort values to the lowest Codex effort', () => {
    expect(normalizeCodexReasoningEffort('none')).toBe('low');
    expect(normalizeCodexReasoningEffort('minimal')).toBe('low');
    expect(normalizeCodexReasoningEffort('high')).toBe('high');
  });

  test('starts with only safe host environment and keeps unrelated built-in capabilities disabled', () => {
    const environment = buildCodexAppServerEnvironment({
      PATH: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      CODEX_HOME: 'C:\\Users\\reader\\.codex',
      OPENAI_API_KEY: 'must-not-reach-codex',
      OPENROUTER_API_KEY: 'must-not-reach-codex',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-reach-codex',
    });
    const command = buildCodexAppServerCommand('codex');
    const imageCommand = buildCodexAppServerCommand('codex', { allowImageGeneration: true });
    const disabledFeatures = command.flatMap((argument, index) =>
      argument === '--disable' ? [command[index + 1]] : []
    );

    expect(environment).toEqual({
      PATH: 'C:\\Windows\\System32',
      TEMP: 'C:\\Temp',
      CODEX_HOME: 'C:\\Users\\reader\\.codex',
    });
    expect(disabledFeatures).toEqual(
      expect.arrayContaining([
        'apps',
        'browser_use',
        'computer_use',
        'image_generation',
        'plugins',
        'shell_tool',
        'unified_exec',
        'workspace_dependencies',
      ])
    );
    expect(command).toEqual(
      expect.arrayContaining(['shell_environment_policy.inherit=none', 'mcp_servers={}'])
    );
    expect(disabledFeatures).not.toEqual(
      expect.arrayContaining(['standalone_web_search', 'web_search_cached', 'web_search_request'])
    );
    const imageGenerationArgumentIndex = imageCommand.indexOf('image_generation');
    expect(imageCommand[imageGenerationArgumentIndex - 1]).toBe('--enable');
    const codeModeArgumentIndex = imageCommand.indexOf('code_mode_host');
    expect(imageCommand[codeModeArgumentIndex - 1]).toBe('--enable');
    expect(disabledFeatures).toContain('code_mode_host');
    expect(imageCommand).toEqual(expect.arrayContaining(['--disable', 'shell_tool']));
  });

  test('performs the mandatory handshake and reads paginated account/model contracts', async () => {
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, { userAgent: 'codex-test/1.0' });
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus', email: 'reader@example.test' },
          requiresOpenaiAuth: true,
        });
      } else if (
        message.method === 'model/list' &&
        (!message.params || typeof message.params !== 'object' || !('cursor' in message.params))
      ) {
        respond(fakeProcess, message, {
          data: [
            {
              model: 'gpt-test-a',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'medium' },
              ],
            },
          ],
          nextCursor: 'page-2',
        });
      } else if (message.method === 'model/list') {
        respond(fakeProcess, message, {
          data: [
            {
              model: 'gpt-test-b',
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
          nextCursor: null,
        });
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    const account = await readCodexAccount(client);
    const models = await listCodexModels(client);

    expect(account).toEqual({
      email: 'reader@example.test',
      requiresOpenaiAuth: true,
      type: 'chatgpt',
    });
    expect(models).toEqual([
      {
        defaultReasoningEffort: 'medium',
        model: 'gpt-test-a',
        supportedReasoningEfforts: ['low', 'medium'],
      },
      {
        defaultReasoningEffort: 'high',
        model: 'gpt-test-b',
        supportedReasoningEfforts: ['high'],
      },
    ]);
    expect(fakeProcess.received.map(message => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
      'model/list',
    ]);
    expect(fakeProcess.received[0]).toMatchObject({
      params: {
        clientInfo: { name: 'nous_reader', title: 'Nous Reader' },
        capabilities: { experimentalApi: true },
      },
    });
    expect(fakeProcess.received[1]).not.toHaveProperty('id');
    expect(fakeProcess.received.every(message => !('jsonrpc' in message))).toBe(true);
    client.close();
  });

  test.each([
    false,
    true,
  ])('runs an ephemeral turn with exchange capture %s', async captureEnabled => {
    const exchanges: ModelExchange[] = [];
    let fakeProcess: FakeCodexProcess;
    let toolResponse: WireMessage | undefined;
    let clientToolResponse: WireMessage | undefined;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus', apiKey: 'private-auth-value' },
          requiresOpenaiAuth: true,
        });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'thread-nous' } });
      } else if (message.method === 'turn/start') {
        respond(fakeProcess, message, { turn: { id: 'turn-nous' } });
        queueMicrotask(() => {
          fakeProcess.send({
            id: 'server-tool-1',
            method: 'item/tool/call',
            params: {
              arguments: { query: 'grafi' },
              callId: 'call-1',
              threadId: 'thread-nous',
              tool: 'searchLibrary',
              turnId: 'turn-nous',
            },
          });
        });
      } else if (message.id === 'server-tool-1' && 'result' in message) {
        toolResponse = message;
        fakeProcess.send({
          id: 'server-tool-2',
          method: 'item/tool/call',
          params: {
            arguments: { noteDraft: 'Nota' },
            callId: 'call-2',
            threadId: 'thread-nous',
            tool: 'requestAddToNotes',
            turnId: 'turn-nous',
          },
        });
      } else if (message.id === 'server-tool-2' && 'result' in message) {
        clientToolResponse = message;
        fakeProcess.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-nous',
            item: { id: 'commentary', type: 'agentMessage', text: 'Checking the sources.' },
          },
        });
        fakeProcess.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-nous',
            turnId: 'turn-nous',
            item: {
              type: 'imageGeneration',
              status: 'completed',
              result: 'ZmFrZS1pbWFnZQ==',
            },
          },
        });
        fakeProcess.send({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-nous',
            tokenUsage: {
              last: {
                cachedInputTokens: 6,
                inputTokens: 20,
                outputTokens: 8,
                reasoningOutputTokens: 3,
                totalTokens: 28,
              },
              modelContextWindow: 100_000,
              total: {
                cachedInputTokens: 6,
                inputTokens: 20,
                outputTokens: 8,
                reasoningOutputTokens: 3,
                totalTokens: 28,
              },
            },
            turnId: 'turn-nous',
          },
        });
        fakeProcess.send({
          method: 'item/reasoning/summaryTextDelta',
          params: {
            threadId: 'thread-nous',
            turnId: 'turn-nous',
            delta: 'Analizzo.',
            headers: { authorization: 'private-auth-value' },
          },
        });
        fakeProcess.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-nous',
            turnId: 'turn-nous',
            item: {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'Analizzo.' },
                { type: 'summary_text', text: 'Controllo la risposta.' },
              ],
            },
          },
        });
        fakeProcess.send({
          method: 'item/reasoning/textDelta',
          params: { threadId: 'thread-nous', turnId: 'turn-nous', delta: 'Exposed reasoning.' },
        });
        fakeProcess.send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'other-thread', turnId: 'turn-other', delta: 'ignora' },
        });
        fakeProcess.send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-nous', turnId: 'turn-nous', delta: 'Risposta' },
        });
        fakeProcess.send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-nous', turnId: 'turn-nous', delta: '\n\n' },
        });
        fakeProcess.send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-nous', turnId: 'turn-nous', delta: 'finale' },
        });
        fakeProcess.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-nous',
            turnId: 'turn-nous',
            item: { type: 'agentMessage', text: 'Risposta\n\nfinale' },
          },
        });
        fakeProcess.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-nous',
            turn: { id: 'turn-nous', status: 'completed' },
          },
        });
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    const deltas: string[] = [];
    const imageResults: string[] = [];
    const reasoningDeltas: string[] = [];
    const toolEvents: unknown[] = [];
    const recordAiUsage = vi.fn(async () => undefined);
    const run = () =>
      runWithWorkflowAttemptMetering(
        {
          attemptNumber: 2,
          nodeInstanceId: 'root/codex',
          record: recordAiUsage,
          runId: '11111111-1111-4111-8111-111111111111',
        },
        () =>
          runCodexAppServerTurnWithClient(
            {
              developerInstructions: 'Rispondi come tutor.',
              get role() {
                if (!captureEnabled) throw new Error('Disabled capture accessed metadata');
                return 'tutor';
              },
              slot: 'chat',
              outputSchemaName: 'tutor_response',
              input: [{ type: 'text', text: 'Spiega i grafi.' }],
              model: 'gpt-test-a',
              onImageGenerated: image => imageResults.push(image),
              onReasoningDelta: delta => reasoningDeltas.push(delta),
              onTextDelta: delta => deltas.push(delta),
              onToolEnd: (callId, output) => toolEvents.push({ callId, output }),
              onToolStart: (callId, name, input, execution) =>
                toolEvents.push({ callId, name, input, execution }),
              reasoningEffort: 'medium',
              serviceTier: 'fast',
              tools: [
                {
                  description: 'Cerca nella libreria.',
                  execute: async input => ({ input, matches: 3 }),
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                  },
                  name: 'searchLibrary',
                },
                {
                  description: 'Propone una nota nel client.',
                  inputSchema: {
                    type: 'object',
                    properties: { noteDraft: { type: 'string' } },
                    required: ['noteDraft'],
                  },
                  name: 'requestAddToNotes',
                },
              ],
            },
            client
          )
      );

    const result = await (captureEnabled ? withModelExchanges(exchanges, run) : run());
    if (captureEnabled) {
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]).toMatchObject({
        provider: 'codex',
        model: 'gpt-test-a',
        slot: 'chat',
        role: 'tutor',
        reasoningEffort: 'medium',
        serviceTier: 'fast',
        workflow: {
          runId: '11111111-1111-4111-8111-111111111111',
          nodeInstanceId: 'root/codex',
          attemptNumber: 2,
        },
        request: {
          developer: 'Rispondi come tutor.',
          input: [{ type: 'text', text: 'Spiega i grafi.' }],
          outputSchemaName: 'tutor_response',
        },
        response: 'Checking the sources.\n\nRisposta\n\nfinale',
        reasoningSummary: 'Analizzo.\nControllo la risposta.',
        reasoningText: 'Exposed reasoning.',
        usage: { inputTokens: 20, outputTokens: 8 },
        status: 'completed',
        latencyMs: expect.any(Number),
      });
      expect(exchanges[0]?.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callId: 'call-1',
            name: 'searchLibrary',
            output: { input: { query: 'grafi' }, matches: 3 },
          }),
        ])
      );
      expect(JSON.stringify(exchanges)).not.toContain('private-auth-value');
    } else expect(exchanges).toEqual([]);

    expect(reasoningDeltas).toEqual([
      'Analizzo.',
      '\nControllo la risposta.',
      'Exposed reasoning.',
    ]);
    expect(imageResults).toEqual(['ZmFrZS1pbWFnZQ==']);

    expect(result).toBe('Risposta\n\nfinale');
    expect(recordAiUsage).toHaveBeenCalledWith({
      attemptNumber: 2,
      cacheReadTokens: 6,
      id: expect.any(String),
      inputTokens: 20,
      model: 'gpt-test-a',
      nodeInstanceId: 'root/codex',
      outputTokens: 8,
      provider: 'codex',
      reasoningTokens: 3,
      runId: '11111111-1111-4111-8111-111111111111',
    });
    expect(deltas).toEqual(['Risposta', '\n\n', 'finale']);
    expect(toolEvents).toEqual([
      {
        callId: 'call-1',
        name: 'searchLibrary',
        input: { query: 'grafi' },
        execution: 'server',
      },
      { callId: 'call-1', output: { input: { query: 'grafi' }, matches: 3 } },
      {
        callId: 'call-2',
        name: 'requestAddToNotes',
        input: { noteDraft: 'Nota' },
        execution: 'client',
      },
    ]);
    expect(toolResponse?.result).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: JSON.stringify({ input: { query: 'grafi' }, matches: 3 }),
        },
      ],
      success: true,
    });
    expect(clientToolResponse?.result).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: JSON.stringify({ status: 'awaiting_client_result' }),
        },
      ],
      success: true,
    });
    expect(fakeProcess.received.find(message => message.method === 'thread/start')).toMatchObject({
      params: {
        approvalPolicy: 'never',
        config: { web_search: 'disabled' },
        dynamicTools: [
          {
            type: 'function',
            name: 'searchLibrary',
          },
          {
            type: 'function',
            name: 'requestAddToNotes',
          },
        ],
        environments: [],
        ephemeral: true,
        runtimeWorkspaceRoots: [],
        sandbox: 'read-only',
        selectedCapabilityRoots: [],
        serviceTier: 'fast',
      },
    });
    expect(fakeProcess.received.find(message => message.method === 'turn/start')).toMatchObject({
      params: {
        effort: 'medium',
        sandboxPolicy: { type: 'readOnly' },
        threadId: 'thread-nous',
      },
    });
    client.close();
  });

  test('enables live web search only for an explicitly authorized turn', async () => {
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus' },
          requiresOpenaiAuth: true,
        });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'thread-research' } });
      } else if (message.method === 'turn/start') {
        respond(fakeProcess, message, { turn: { id: 'turn-research' } });
        fakeProcess.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-research',
            turnId: 'turn-research',
            item: { type: 'agentMessage', text: '{"sources":[]}' },
          },
        });
        fakeProcess.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-research',
            turn: { id: 'turn-research', status: 'completed' },
          },
        });
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    await runCodexAppServerTurnWithClient(
      {
        allowWebSearch: true,
        developerInstructions: 'Cerca fonti affidabili.',
        input: [{ type: 'text', text: 'Ricerca i grafi.' }],
        model: 'gpt-test-a',
        reasoningEffort: 'medium',
      },
      client
    );

    expect(fakeProcess.received.find(message => message.method === 'thread/start')).toMatchObject({
      params: { config: { web_search: 'live' } },
    });
    client.close();
  });

  test('surfaces the app-server reason when a turn fails', async () => {
    const exchanges: ModelExchange[] = [];
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus' },
          requiresOpenaiAuth: true,
        });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'thread-failed' } });
      } else if (message.method === 'turn/start') {
        respond(fakeProcess, message, { turn: { id: 'turn-failed' } });
        fakeProcess.send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-failed',
            turn: {
              id: 'turn-failed',
              status: 'failed',
              error: { code: 'rate_limit', message: 'Too many requests.' },
            },
          },
        });
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    await expect(
      withModelExchanges(exchanges, () =>
        runCodexAppServerTurnWithClient(
          {
            developerInstructions: 'Tutor.',
            input: [{ type: 'text', text: 'Ciao' }],
            model: 'gpt-test-a',
            reasoningEffort: 'minimal',
          },
          client
        )
      )
    ).rejects.toMatchObject<CodexAppServerError>({
      code: 'protocol',
      message: 'Codex turn failed: rate_limit: Too many requests.',
    });
    expect(fakeProcess.received.find(message => message.method === 'turn/start')).toMatchObject({
      params: { effort: 'low', summary: 'none' },
    });
    expect(exchanges).toMatchObject([
      {
        status: 'failed',
        error: 'CodexAppServerError',
        reasoningEffort: 'low',
        endedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(exchanges)).not.toContain('Too many requests.');
    client.close();
  });

  test('interrupts the active Codex turn when its abort signal fires', async () => {
    const exchanges: ModelExchange[] = [];
    await withModelExchanges(exchanges, async () => {
      const recordAiUsage = vi.fn(async () => undefined);
      let finishInterruptedTurn = () => undefined;
      let fakeProcess: FakeCodexProcess;
      fakeProcess = new FakeCodexProcess(message => {
        if (message.method === 'initialize') {
          respond(fakeProcess, message, {});
        } else if (message.method === 'account/read') {
          respond(fakeProcess, message, {
            account: { type: 'chatgpt', planType: 'plus' },
            requiresOpenaiAuth: true,
          });
        } else if (message.method === 'thread/start') {
          respond(fakeProcess, message, { thread: { id: 'thread-abort' } });
        } else if (message.method === 'turn/start') {
          respond(fakeProcess, message, { turn: { id: 'turn-abort' } });
        } else if (message.method === 'turn/interrupt') {
          respond(fakeProcess, message, {});
          finishInterruptedTurn = () => {
            sendInterruptedTurnCompletion(
              fakeProcess,
              { threadId: 'thread-abort', turnId: 'turn-abort' },
              {
                cacheReadTokens: 5,
                inputTokens: 13,
                outputTokens: 7,
                reasoningTokens: 2,
              }
            );
          };
        }
      });

      const client = await startCodexAppServerClient(() => fakeProcess as never);
      const controller = new AbortController();
      const turnPromise = runWithWorkflowAttemptMetering(
        {
          attemptNumber: 3,
          nodeInstanceId: 'root/codex-abort',
          record: recordAiUsage,
          runId: '33333333-3333-4333-8333-333333333333',
        },
        () =>
          runCodexAppServerTurnWithClient(
            {
              developerInstructions: 'Tutor.',
              input: [{ type: 'text', text: 'Ciao' }],
              model: 'gpt-test-a',
              reasoningEffort: 'low',
              signal: controller.signal,
            },
            client
          )
      );
      await vi.waitFor(() => {
        expect(fakeProcess.received.some(message => message.method === 'turn/start')).toBe(true);
      });
      controller.abort();

      await expect(turnPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(recordAiUsage).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(
          fakeProcess.received.find(message => message.method === 'turn/interrupt')
        ).toMatchObject({
          params: { threadId: 'thread-abort', turnId: 'turn-abort' },
        });
      });
      finishInterruptedTurn();
      await vi.waitFor(() => {
        expect(recordAiUsage).toHaveBeenCalledWith({
          attemptNumber: 3,
          cacheReadTokens: 5,
          id: expect.any(String),
          inputTokens: 13,
          model: 'gpt-test-a',
          nodeInstanceId: 'root/codex-abort',
          outputTokens: 7,
          provider: 'codex',
          reasoningTokens: 2,
          runId: '33333333-3333-4333-8333-333333333333',
        });
      });
      client.close();
    });
    expect(exchanges).toMatchObject([
      {
        status: 'interrupted',
        endedAt: expect.any(String),
        usage: { inputTokens: 13, outputTokens: 7 },
        workflow: { attemptNumber: 3, nodeInstanceId: 'root/codex-abort' },
      },
    ]);
  });

  test('interrupts a timed-out turn and records usage from its terminal event', async () => {
    vi.useFakeTimers();
    const recordAiUsage = vi.fn(async () => undefined);
    let finishInterruptedTurn = () => undefined;
    let resolveTurnStarted = () => undefined;
    const turnStarted = new Promise<void>(resolve => {
      resolveTurnStarted = resolve;
    });
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus' },
          requiresOpenaiAuth: true,
        });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'thread-timeout' } });
      } else if (message.method === 'turn/start') {
        respond(fakeProcess, message, { turn: { id: 'turn-timeout' } });
        resolveTurnStarted();
      } else if (message.method === 'turn/interrupt') {
        respond(fakeProcess, message, {});
        finishInterruptedTurn = () => {
          sendInterruptedTurnCompletion(
            fakeProcess,
            { threadId: 'thread-timeout', turnId: 'turn-timeout' },
            {
              cacheReadTokens: 3,
              inputTokens: 11,
              outputTokens: 5,
              reasoningTokens: 1,
            }
          );
        };
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    const turnPromise = runWithWorkflowAttemptMetering(
      {
        attemptNumber: 4,
        nodeInstanceId: 'root/codex-timeout',
        record: recordAiUsage,
        runId: '44444444-4444-4444-8444-444444444444',
      },
      () =>
        runCodexAppServerTurnWithClient(
          {
            developerInstructions: 'Tutor.',
            input: [{ type: 'text', text: 'Ciao' }],
            model: 'gpt-test-a',
            reasoningEffort: 'low',
          },
          client
        )
    );
    await turnStarted;

    const timeoutResult = expect(turnPromise).rejects.toMatchObject<CodexAppServerError>({
      code: 'timeout',
      message: 'Codex turn timed out.',
    });
    await vi.advanceTimersToNextTimerAsync();
    await timeoutResult;
    expect(fakeProcess.received.find(message => message.method === 'turn/interrupt')).toMatchObject(
      {
        params: { threadId: 'thread-timeout', turnId: 'turn-timeout' },
      }
    );

    finishInterruptedTurn();
    await vi.waitFor(() => {
      expect(recordAiUsage).toHaveBeenCalledWith({
        attemptNumber: 4,
        cacheReadTokens: 3,
        id: expect.any(String),
        inputTokens: 11,
        model: 'gpt-test-a',
        nodeInstanceId: 'root/codex-timeout',
        outputTokens: 5,
        provider: 'codex',
        reasoningTokens: 1,
        runId: '44444444-4444-4444-8444-444444444444',
      });
    });
    client.close();
  });

  test('stops before opening a thread when Codex has no authenticated account', async () => {
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, { account: null, requiresOpenaiAuth: true });
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    await expect(
      runCodexAppServerTurnWithClient(
        {
          developerInstructions: 'Tutor.',
          input: [{ type: 'text', text: 'Ciao' }],
          model: 'gpt-test-a',
          reasoningEffort: 'low',
        },
        client
      )
    ).rejects.toMatchObject<CodexAppServerError>({ code: 'not_authenticated' });
    expect(fakeProcess.received.some(message => message.method === 'thread/start')).toBe(false);
    client.close();
  });
});

describe('direct Codex startup cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test.each([
    'before spawn',
    'initialize',
    'account/read',
    'thread/start',
  ])('stops subsequent startup work when aborted at %s', async stage => {
    vi.stubEnv('CODEX_APP_SERVER_ENABLED', 'true');
    const controller = new AbortController();
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') respond(fakeProcess, message, {});
      if (message.method === 'account/read')
        respond(fakeProcess, message, { requiresOpenaiAuth: false });
      if (message.method === 'thread/start')
        respond(fakeProcess, message, { thread: { id: 'startup-thread' } });
      if (message.method === stage) controller.abort();
    });
    const spawn = stubCodexSpawn(fakeProcess);
    if (stage === 'before spawn') controller.abort();
    try {
      await expect(
        runCodexAppServerTurn({
          developerInstructions: 'Tutor.',
          input: [{ type: 'text', text: 'Hello' }],
          model: 'fixture-model',
          reasoningEffort: 'low',
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      if (stage === 'before spawn') {
        expect(spawn).not.toHaveBeenCalled();
      } else {
        expect(fakeProcess.received.at(-1)?.method).toBe(stage);
        expect(fakeProcess.kill).toHaveBeenCalledOnce();
      }
    } finally {
      fakeProcess.stdout.end();
      fakeProcess.stderr.end();
    }
  });

  test.each([
    'initialize',
    'account/read',
    'thread/start',
    'turn/start',
  ])('closes a pending %s request on abort and settles unknown usage', async stage => {
    vi.stubEnv('CODEX_APP_SERVER_ENABLED', 'true');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const reachedStage = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    const record = vi.fn(async (_usage: unknown) => recorded.promise);
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === stage) {
        reachedStage.resolve();
        return;
      }
      if (message.method === 'initialize') respond(fakeProcess, message, {});
      if (message.method === 'account/read')
        respond(fakeProcess, message, { requiresOpenaiAuth: false });
      if (message.method === 'thread/start')
        respond(fakeProcess, message, { thread: { id: 'startup-thread' } });
    });
    stubCodexSpawn(fakeProcess);
    let outcome: unknown;
    const reason = new Error('Caller cancelled startup.');
    let scopeSettled = false;
    const pending = withSettledCodexUsage(() =>
      runWithWorkflowAttemptMetering(
        { runId: 'startup', nodeInstanceId: 'direct-turn', attemptNumber: 1, record },
        () =>
          runCodexAppServerTurn({
            developerInstructions: 'Tutor.',
            input: [{ type: 'text', text: 'Hello' }],
            model: 'fixture-model',
            reasoningEffort: 'low',
            signal: controller.signal,
          })
      ).catch(error => {
        outcome = error;
      })
    ).then(() => {
      scopeSettled = true;
    });
    try {
      await reachedStage.promise;
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe(reason);
      expect(scopeSettled).toBe(false);
      expect(fakeProcess.kill).toHaveBeenCalledOnce();
      expect(fakeProcess.stdin.writableEnded).toBe(true);
      expect(record).toHaveBeenCalledOnce();
      const usage = record.mock.calls[0][0];
      expect(usage).toMatchObject({ model: 'fixture-model', provider: 'codex' });
      expect(usage).not.toHaveProperty('inputTokens');
      expect(usage).not.toHaveProperty('outputTokens');
      expect(usage).not.toHaveProperty('providerCost');
      expect(fakeProcess.received.at(-1)?.method).toBe(stage);
      recorded.resolve();
      await pending;
      expect(scopeSettled).toBe(true);
    } finally {
      recorded.resolve();
      fakeProcess.emit('exit', 0);
      await vi.runAllTimersAsync();
      await pending;
      fakeProcess.stdout.end();
      fakeProcess.stderr.end();
    }
  });
});

describe('interrupted direct Codex run evidence', () => {
  test.each([
    'late',
    'missing',
    'starting',
    'initializing',
  ] as const)('persists %s usage before finalizing the manifest and history', async usageReport => {
    const directory = await mkdtemp(join(tmpdir(), 'nous-codex-evidence-'));
    vi.stubEnv('NOUS_E2E_DATA', directory);
    vi.stubEnv('CODEX_APP_SERVER_ENABLED', 'true');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const interrupted = Promise.withResolvers<void>();
    const callerFailed = Promise.withResolvers<void>();
    const turnStarting = Promise.withResolvers<void>();
    let startTurn = () => undefined;
    let initialize = () => undefined;
    const finalize = vi.fn(async (persist: () => Promise<void>) => persist());
    let runDirectory = '';
    let fakeProcess: FakeCodexProcess;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        initialize = () => respond(fakeProcess, message, {});
        if (usageReport === 'initializing') turnStarting.resolve();
        else initialize();
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, { requiresOpenaiAuth: false });
      } else if (message.method === 'thread/start') {
        respond(fakeProcess, message, { thread: { id: 'evidence-thread' } });
      } else if (message.method === 'turn/start') {
        startTurn = () => {
          respond(fakeProcess, message, { turn: { id: 'evidence-turn' } });
          controller.abort();
        };
        turnStarting.resolve();
        if (usageReport !== 'starting') startTurn();
      } else if (message.method === 'turn/interrupt') {
        respond(fakeProcess, message, {});
        interrupted.resolve();
      }
    });
    const spawn = stubCodexSpawn(fakeProcess);
    try {
      const run = withRunEvidence(
        { scenario: 'interrupted', provider: 'codex', slots: {} },
        async recorder => {
          runDirectory = recorder.directory;
          try {
            const turn = recorder.measure({ kind: 'call', name: 'direct-turn' }, () =>
              runCodexAppServerTurn({
                developerInstructions: 'Tutor.',
                input: [{ type: 'text', text: 'Hello' }],
                model: 'fixture-model',
                reasoningEffort: 'low',
                signal: controller.signal,
              })
            );
            await Promise.all([
              turn,
              turnStarting.promise.then(() => {
                if (usageReport === 'starting' || usageReport === 'initializing')
                  throw new Error('Sibling failed during startup.');
              }),
            ]);
          } catch (error) {
            callerFailed.resolve();
            throw error;
          }
        },
        finalize
      );
      const result = run.catch(error => error);
      await callerFailed.promise;
      await vi.advanceTimersByTimeAsync(0);
      const finalizedBeforeUsage = finalize.mock.calls.length;
      if (usageReport === 'starting') startTurn();
      if (usageReport === 'initializing') initialize();
      await interrupted.promise;
      if (usageReport !== 'missing') {
        sendInterruptedTurnCompletion(
          fakeProcess,
          { threadId: 'evidence-thread', turnId: 'evidence-turn' },
          { cacheReadTokens: 5, inputTokens: 13, outputTokens: 7, reasoningTokens: 2 }
        );
      } else {
        await vi.runAllTimersAsync();
      }
      expect(await result).toMatchObject(
        usageReport === 'starting' || usageReport === 'initializing'
          ? { message: 'Sibling failed during startup.' }
          : { name: 'AbortError' }
      );
      expect(finalizedBeforeUsage).toBe(0);
      const manifest: RunManifest = JSON.parse(
        await readFile(join(runDirectory, 'manifest.json'), 'utf8')
      );
      const history: RunManifest = JSON.parse(
        await readFile(join(directory, 'runs', 'interrupted', 'history.jsonl'), 'utf8')
      );
      expect(history).toEqual(manifest);
      expect(manifest.outcome).toBe('failed');
      expect(manifest.aiUsage).toHaveLength(1);
      expect(manifest.aiUsage[0]).toMatchObject({
        model: 'fixture-model',
        provider: 'codex',
        nodeInstanceId: 'direct-turn',
      });
      if (usageReport !== 'missing') {
        expect(manifest.aiUsage[0]).toMatchObject({ inputTokens: 13, outputTokens: 7 });
      } else {
        expect(manifest.aiUsage[0].inputTokens).toBeUndefined();
        expect(manifest.aiUsage[0].outputTokens).toBeUndefined();
        expect(manifest.aiUsage[0].providerCost).toBeUndefined();
      }
    } finally {
      fakeProcess.stdout.end();
      fakeProcess.stderr.end();
      spawn.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
