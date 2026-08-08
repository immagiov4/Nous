import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildCodexAppServerCommand,
  buildCodexAppServerEnvironment,
  type CodexAppServerError,
  listCodexModels,
  normalizeCodexReasoningEffort,
  readCodexAccount,
  runCodexAppServerTurnWithClient,
  startCodexAppServerClient,
} from '../../src/services/codexAppServer.js';
import { runWithWorkflowAttemptMetering } from '../../src/workflows/workflowAiMetering.js';

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

const respond = (process: FakeCodexProcess, request: WireMessage, result: unknown): void => {
  process.send({ id: request.id, result });
};

describe('Codex app-server protocol client', () => {
  beforeEach(() => {
    process.env.CODEX_APP_SERVER_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.CODEX_APP_SERVER_ENABLED;
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

  test('runs an ephemeral turn, executes a dynamic tool, and streams only the matching thread', async () => {
    let fakeProcess: FakeCodexProcess;
    let toolResponse: WireMessage | undefined;
    let clientToolResponse: WireMessage | undefined;
    fakeProcess = new FakeCodexProcess(message => {
      if (message.method === 'initialize') {
        respond(fakeProcess, message, {});
      } else if (message.method === 'account/read') {
        respond(fakeProcess, message, {
          account: { type: 'chatgpt', planType: 'plus' },
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
          params: { threadId: 'thread-nous', turnId: 'turn-nous', delta: 'Analizzo.' },
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
    const result = await runWithWorkflowAttemptMetering(
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

    expect(reasoningDeltas).toEqual(['Analizzo.', '\nControllo la risposta.']);
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
      runCodexAppServerTurnWithClient(
        {
          developerInstructions: 'Tutor.',
          input: [{ type: 'text', text: 'Ciao' }],
          model: 'gpt-test-a',
          reasoningEffort: 'minimal',
        },
        client
      )
    ).rejects.toMatchObject<CodexAppServerError>({
      code: 'protocol',
      message: 'Codex turn failed: rate_limit: Too many requests.',
    });
    expect(fakeProcess.received.find(message => message.method === 'turn/start')).toMatchObject({
      params: { effort: 'low', summary: 'none' },
    });
    client.close();
  });

  test('interrupts the active Codex turn when its abort signal fires', async () => {
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
      }
    });

    const client = await startCodexAppServerClient(() => fakeProcess as never);
    const controller = new AbortController();
    const turnPromise = runCodexAppServerTurnWithClient(
      {
        developerInstructions: 'Tutor.',
        input: [{ type: 'text', text: 'Ciao' }],
        model: 'gpt-test-a',
        reasoningEffort: 'low',
        signal: controller.signal,
      },
      client
    );
    await vi.waitFor(() => {
      expect(fakeProcess.received.some(message => message.method === 'turn/start')).toBe(true);
    });
    controller.abort();

    await expect(turnPromise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(
        fakeProcess.received.find(message => message.method === 'turn/interrupt')
      ).toMatchObject({
        params: { threadId: 'thread-abort', turnId: 'turn-abort' },
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
