import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { Readable } from 'node:stream';

import type { ReasoningEffort } from '../config/modelConfig.js';
import { recordWorkflowAiUsage, type WorkflowAiUsage } from '../workflows/workflowAiMetering.js';

const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_TURN_TIMEOUT_MS = 10 * 60_000;
const CODEX_BASE_INSTRUCTIONS =
  'You are the Nous Reader text engine. Use only capabilities explicitly supplied by Nous. Never inspect the host filesystem, environment, applications, or browser. If a dynamic tool returns status "awaiting_client_result", end the turn immediately without inventing its result.';
const CODEX_OFFLINE_INSTRUCTION = 'Do not access the network.';
const CODEX_WEB_RESEARCH_INSTRUCTION =
  'Web search is available for this research request. Search and open enough relevant sources to support the requested result, and preserve source URLs in the structured output.';
const CODEX_IMAGE_GENERATION_INSTRUCTION =
  'The built-in image generation capability is available for this request. Use it exactly once to generate the requested PNG.';
const CODEX_DELEGATED_TOOL_RESULT = JSON.stringify({ status: 'awaiting_client_result' });
const CODEX_DISABLED_BUILTIN_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode_host',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'memories',
  'multi_agent',
  'plugins',
  'request_permissions_tool',
  'shell_tool',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
] as const;
const CODEX_SAFE_ENVIRONMENT_VARIABLES = [
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;
const CODEX_CLIENT_INFO = {
  name: 'nous_reader',
  title: 'Nous Reader',
  version: '0.0.0',
} as const;

type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface CodexProcess {
  kill: () => unknown;
  once: (event: 'error' | 'exit', listener: (...argumentsValue: unknown[]) => void) => unknown;
  stderr: Readable;
  stdin: {
    end: () => unknown;
    write: (chunk: string) => unknown;
  };
  stdout: Readable;
}

export interface CodexAccountSummary {
  email?: string;
  requiresOpenaiAuth: boolean;
  type?: string;
}

export interface CodexModelSummary {
  defaultReasoningEffort?: string;
  model: string;
  supportedReasoningEfforts: string[];
}

export interface CodexTurnTool {
  description: string;
  execute?: (argumentsValue: unknown, callId: string) => Promise<unknown>;
  inputSchema: JsonObject;
  name: string;
}

export type CodexToolExecution = 'client' | 'server';

export interface CodexTurnInput {
  allowImageGeneration?: boolean;
  allowWebSearch?: boolean;
  developerInstructions: string;
  input: Array<{ text: string; type: 'text' } | { type: 'image'; url: string }>;
  model: string;
  onImageGenerated?: (result: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolEnd?: (callId: string, output: unknown) => void;
  onToolStart?: (
    callId: string,
    name: string,
    input: unknown,
    execution: CodexToolExecution
  ) => void;
  outputSchema?: JsonObject;
  reasoningEffort: ReasoningEffort;
  serviceTier?: 'fast';
  signal?: AbortSignal;
  tools?: CodexTurnTool[];
}

export const normalizeCodexReasoningEffort = (
  reasoningEffort: ReasoningEffort
): Exclude<ReasoningEffort, 'minimal' | 'none'> =>
  reasoningEffort === 'none' || reasoningEffort === 'minimal' ? 'low' : reasoningEffort;

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code: 'disabled' | 'not_authenticated' | 'process' | 'protocol' | 'timeout'
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const readText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const readThreadId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const directThreadId = readString(value.threadId);
  if (directThreadId) {
    return directThreadId;
  }

  return isRecord(value.thread) ? readString(value.thread.id) : undefined;
};

const makeProtocolError = (message: unknown): CodexAppServerError => {
  if (isRecord(message) && isRecord(message.error)) {
    const details = readString(message.error.message);
    return new CodexAppServerError(details || 'Codex app-server request failed.', 'protocol');
  }
  return new CodexAppServerError('Codex app-server request failed.', 'protocol');
};

export class CodexJsonRpcClient {
  readonly #lineReader: ReadLineInterface;
  readonly #notificationListeners = new Set<(method: string, params: unknown) => void>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  #closed = false;
  #nextRequestId = 1;
  #serverRequestHandler?: (request: JsonRpcRequest) => Promise<unknown>;

  constructor(
    readonly process: CodexProcess,
    private readonly requestTimeoutMs = CODEX_REQUEST_TIMEOUT_MS
  ) {
    this.#lineReader = createInterface({ input: process.stdout });
    this.#lineReader.on('line', line => this.#handleLine(line));
    process.stderr.on('data', () => undefined);
    process.once('error', error =>
      this.#failPending(error instanceof Error ? error : new Error(String(error)))
    );
    process.once('exit', code => {
      if (!this.#closed) {
        this.#failPending(
          new CodexAppServerError(
            `Codex app-server exited with code ${code ?? 'unknown'}.`,
            'process'
          )
        );
      }
    });
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    if (this.#closed) {
      throw new CodexAppServerError('Codex app-server connection is closed.', 'process');
    }

    const id = this.#nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(String(id));
        reject(new CodexAppServerError(`Codex app-server timed out during ${method}.`, 'timeout'));
      }, timeoutMs);
      timeout.unref?.();
      this.#pendingRequests.set(String(id), { reject, resolve, timeout });
    });

    this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    return result;
  }

  notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  handleServerRequests(handler: (request: JsonRpcRequest) => Promise<unknown>): void {
    this.#serverRequestHandler = handler;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lineReader.close();
    this.process.stdin.end();
    this.process.kill();
    this.#failPending(new CodexAppServerError('Codex app-server connection closed.', 'process'));
  }

  #write(message: JsonObject): void {
    if (this.#closed) {
      throw new CodexAppServerError('Codex app-server connection is closed.', 'process');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#failPending(
        new CodexAppServerError('Codex app-server returned invalid JSON.', 'protocol')
      );
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      this.#resolveResponse(message);
      return;
    }

    const method = readString(message.method);
    if (!method) {
      return;
    }

    if (message.id !== undefined) {
      void this.#respondToServerRequest({
        id: message.id as JsonRpcId,
        method,
        ...('params' in message ? { params: message.params } : {}),
      });
      return;
    }

    for (const listener of this.#notificationListeners) {
      listener(method, message.params);
    }
  }

  #resolveResponse(message: JsonObject): void {
    const requestId = String(message.id);
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    this.#pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    if ('error' in message) {
      pending.reject(makeProtocolError(message));
      return;
    }
    pending.resolve(message.result);
  }

  async #respondToServerRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (!this.#serverRequestHandler) {
        throw new Error(`Unsupported server request: ${request.method}`);
      }
      const result = await this.#serverRequestHandler(request);
      this.#write({ id: request.id, result });
    } catch {
      console.error('[Codex app-server] Client tool request failed.', { method: request.method });
      this.#write({
        id: request.id,
        error: { code: -32_603, message: 'Operazione non riuscita.' },
      });
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
  }
}

export const isCodexAppServerEnabled = (): boolean =>
  process.env.CODEX_APP_SERVER_ENABLED === 'true';

export const buildCodexAppServerCommand = (
  binary: string,
  options: { allowImageGeneration?: boolean } = {}
): string[] => [
  binary,
  'app-server',
  '--stdio',
  '-c',
  'shell_environment_policy.inherit=none',
  '-c',
  'mcp_servers={}',
  ...CODEX_DISABLED_BUILTIN_FEATURES.filter(
    feature => feature !== 'image_generation' || !options.allowImageGeneration
  ).flatMap(feature => ['--disable', feature]),
  ...(options.allowImageGeneration ? ['--enable', 'image_generation'] : []),
];

export const buildCodexAppServerEnvironment = (
  sourceEnvironment: NodeJS.ProcessEnv
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const name of CODEX_SAFE_ENVIRONMENT_VARIABLES) {
    const value =
      name === 'PATH' ? sourceEnvironment.PATH || sourceEnvironment.Path : sourceEnvironment[name];
    if (value) {
      environment[name] = value;
    }
  }

  const codexHome = sourceEnvironment.CODEX_HOME?.trim();
  if (codexHome) {
    environment.CODEX_HOME = codexHome;
  }
  return environment;
};

const spawnCodexAppServer = (options: { allowImageGeneration?: boolean } = {}): CodexProcess => {
  const binary = process.env.CODEX_BINARY?.trim() || 'codex';
  const subprocess = Bun.spawn(buildCodexAppServerCommand(binary, options), {
    cwd: process.env.CODEX_WORKING_DIRECTORY?.trim() || tmpdir(),
    env: buildCodexAppServerEnvironment(process.env),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const events = new EventEmitter();
  subprocess.exited.then(
    code => events.emit('exit', code),
    error => events.emit('error', error)
  );

  return {
    kill: () => subprocess.kill(),
    once: (event, listener) => events.once(event, listener),
    stderr: Readable.fromWeb(subprocess.stderr as never),
    stdin: {
      end: () => subprocess.stdin.end(),
      write: chunk => subprocess.stdin.write(chunk),
    },
    stdout: Readable.fromWeb(subprocess.stdout as never),
  };
};

export const startCodexAppServerClient = async (
  spawnProcess: () => CodexProcess = spawnCodexAppServer
): Promise<CodexJsonRpcClient> => {
  if (!isCodexAppServerEnabled()) {
    throw new CodexAppServerError('Codex app-server is disabled.', 'disabled');
  }

  const client = new CodexJsonRpcClient(spawnProcess());
  try {
    await client.request('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
};

let managedAccountClientPromise: Promise<CodexJsonRpcClient> | null = null;

export const getManagedCodexAccountClient = (): Promise<CodexJsonRpcClient> => {
  managedAccountClientPromise ??= startCodexAppServerClient().catch(error => {
    managedAccountClientPromise = null;
    throw error;
  });
  return managedAccountClientPromise;
};

const resetManagedCodexAccountClient = async (): Promise<void> => {
  const pendingClient = managedAccountClientPromise;
  managedAccountClientPromise = null;
  if (pendingClient) {
    (await pendingClient.catch(() => null))?.close();
  }
};

export const closeManagedCodexAccountClient = resetManagedCodexAccountClient;
export const resetManagedCodexAccountClientForTesting = resetManagedCodexAccountClient;

export const startCodexDeviceLogin = async (): Promise<unknown> => {
  const client = await getManagedCodexAccountClient();
  return client.request('account/login/start', { type: 'chatgptDeviceCode' });
};

export const cancelCodexLogin = async (loginId: string): Promise<void> => {
  const client = await getManagedCodexAccountClient();
  await client.request('account/login/cancel', { loginId });
};

export const logoutCodexAccount = async (): Promise<void> => {
  const client = await getManagedCodexAccountClient();
  await client.request('account/logout');
  await resetManagedCodexAccountClient();
};

const parseAccountSummary = (response: unknown): CodexAccountSummary => {
  if (!isRecord(response)) {
    throw new CodexAppServerError('Codex account response is invalid.', 'protocol');
  }

  const account = isRecord(response.account) ? response.account : undefined;
  return {
    requiresOpenaiAuth: response.requiresOpenaiAuth === true,
    ...(account
      ? {
          email: readString(account.email),
          type: readString(account.type),
        }
      : {}),
  };
};

export const readCodexAccount = async (client: CodexJsonRpcClient): Promise<CodexAccountSummary> =>
  parseAccountSummary(await client.request('account/read', { refreshToken: false }));

export const listCodexModels = async (client: CodexJsonRpcClient): Promise<CodexModelSummary[]> => {
  const models: CodexModelSummary[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.request('model/list', cursor ? { cursor } : {});
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new CodexAppServerError('Codex model response is invalid.', 'protocol');
    }

    for (const model of response.data) {
      if (!isRecord(model) || !readString(model.model)) {
        continue;
      }
      models.push({
        model: readString(model.model) as string,
        defaultReasoningEffort: readString(model.defaultReasoningEffort),
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map(effort => (isRecord(effort) ? readString(effort.reasoningEffort) : undefined))
              .filter((effort): effort is string => Boolean(effort))
          : [],
      });
    }

    cursor = readString(response.nextCursor);
  } while (cursor);

  return models;
};

const requireAuthenticatedCodexAccount = async (client: CodexJsonRpcClient): Promise<void> => {
  const account = await readCodexAccount(client);
  if (account.requiresOpenaiAuth && !account.type) {
    throw new CodexAppServerError('Codex is not authenticated.', 'not_authenticated');
  }
};

const readAgentMessageText = (params: unknown): string | undefined => {
  if (!isRecord(params) || !isRecord(params.item) || params.item.type !== 'agentMessage') {
    return undefined;
  }
  return readText(params.item.text);
};

const readCompletedReasoningSummary = (params: unknown): string | undefined => {
  if (!isRecord(params) || !isRecord(params.item) || params.item.type !== 'reasoning') {
    return undefined;
  }

  const summary = Array.isArray(params.item.summary)
    ? params.item.summary
        .map(part => (isRecord(part) ? readText(part.text) : undefined))
        .filter((part): part is string => Boolean(part))
        .join('\n')
    : '';
  return readText(summary);
};

const readCompletedImageResult = (params: unknown): string | undefined => {
  if (
    !isRecord(params) ||
    !isRecord(params.item) ||
    params.item.type !== 'imageGeneration' ||
    params.item.status !== 'completed'
  ) {
    return undefined;
  }
  return readText(params.item.result);
};

const readTurnStatus = (params: unknown): string | undefined => {
  if (!isRecord(params) || !isRecord(params.turn)) {
    return undefined;
  }
  return readString(params.turn.status);
};

const readNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const readTurnTokenUsage = (
  params: unknown
): {
  readonly turnId: string;
  readonly usage: Omit<WorkflowAiUsage, 'model' | 'provider'>;
} | null => {
  if (!isRecord(params) || !isRecord(params.tokenUsage) || !isRecord(params.tokenUsage.last)) {
    return null;
  }
  const turnId = readString(params.turnId);
  const inputTokens = readNonNegativeNumber(params.tokenUsage.last.inputTokens);
  const outputTokens = readNonNegativeNumber(params.tokenUsage.last.outputTokens);
  const reasoningTokens = readNonNegativeNumber(params.tokenUsage.last.reasoningOutputTokens);
  const cacheReadTokens = readNonNegativeNumber(params.tokenUsage.last.cachedInputTokens);
  if (
    !turnId ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined ||
    cacheReadTokens === undefined
  ) {
    return null;
  }
  return {
    turnId,
    usage: { cacheReadTokens, inputTokens, outputTokens, reasoningTokens },
  };
};

const readStartedTurnId = (response: unknown): string | undefined =>
  isRecord(response) && isRecord(response.turn) ? readString(response.turn.id) : undefined;

const readTurnFailure = (params: unknown): string | undefined => {
  if (!isRecord(params) || !isRecord(params.turn)) {
    return undefined;
  }

  const error = params.turn.error;
  if (typeof error === 'string') {
    return readString(error);
  }
  if (!isRecord(error)) {
    return undefined;
  }

  return [error.code, error.codexErrorInfo, error.message, error.additionalDetails]
    .map(readString)
    .filter((value): value is string => Boolean(value))
    .join(': ');
};

interface CodexTurnExecution {
  readonly result: Promise<string>;
  readonly settled: Promise<void>;
}

const startCodexAppServerTurnWithClient = async (
  turn: CodexTurnInput,
  client: CodexJsonRpcClient
): Promise<CodexTurnExecution> => {
  turn.signal?.throwIfAborted();
  let completedText = '';
  let streamedText = '';
  let hasStreamedReasoningText = false;
  let streamedReasoningSummary = '';
  const usageByTurnId = new Map<string, Omit<WorkflowAiUsage, 'model' | 'provider'>>();

  await requireAuthenticatedCodexAccount(client);
  const toolsByName = new Map((turn.tools || []).map(tool => [tool.name, tool]));
  client.handleServerRequests(async request => {
    if (request.method !== 'item/tool/call' || !isRecord(request.params)) {
      throw new Error(`Unsupported Codex server request: ${request.method}`);
    }

    const name = readString(request.params.tool);
    const callId = readString(request.params.callId);
    const tool = name ? toolsByName.get(name) : undefined;
    if (!tool || !callId) {
      throw new Error('Unknown Codex dynamic tool call.');
    }

    const argumentsValue = request.params.arguments;
    const execution: CodexToolExecution = tool.execute ? 'server' : 'client';
    turn.onToolStart?.(callId, tool.name, argumentsValue, execution);
    if (!tool.execute) {
      return {
        contentItems: [{ type: 'inputText', text: CODEX_DELEGATED_TOOL_RESULT }],
        success: true,
      };
    }

    const output = await tool.execute(argumentsValue, callId);
    turn.onToolEnd?.(callId, output);
    return {
      contentItems: [{ type: 'inputText', text: JSON.stringify(output ?? null) }],
      success: true,
    };
  });

  const webSearchMode = turn.allowWebSearch ? 'live' : 'disabled';
  const threadResponse = await client.request('thread/start', {
    approvalPolicy: 'never',
    baseInstructions: [
      CODEX_BASE_INSTRUCTIONS,
      turn.allowWebSearch ? CODEX_WEB_RESEARCH_INSTRUCTION : CODEX_OFFLINE_INSTRUCTION,
      ...(turn.allowImageGeneration ? [CODEX_IMAGE_GENERATION_INSTRUCTION] : []),
    ].join('\n'),
    config: { web_search: webSearchMode },
    cwd: process.env.CODEX_WORKING_DIRECTORY?.trim() || tmpdir(),
    developerInstructions: turn.developerInstructions,
    dynamicTools: (turn.tools || []).map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ephemeral: true,
    environments: [],
    model: turn.model,
    serviceTier: turn.serviceTier,
    runtimeWorkspaceRoots: [],
    sandbox: 'read-only',
    selectedCapabilityRoots: [],
  });
  const threadId = readThreadId(threadResponse);
  if (!threadId) {
    throw new CodexAppServerError('Codex did not return a thread id.', 'protocol');
  }

  let cleanupCancellation = () => undefined;
  let cleanupTurnListener = () => undefined;
  let rejectTurnCompleted: (error: unknown) => void = () => undefined;
  let resolveTurnCompleted: (result: string) => void = () => undefined;
  let turnCompletedSettled = false;
  const turnCompleted = new Promise<string>((resolve, reject) => {
    rejectTurnCompleted = error => {
      if (turnCompletedSettled) return;
      turnCompletedSettled = true;
      cleanupTurnListener();
      reject(error);
    };
    resolveTurnCompleted = result => {
      if (turnCompletedSettled) return;
      turnCompletedSettled = true;
      cleanupTurnListener();
      resolve(result);
    };

    const unsubscribe = client.onNotification((method, params) => {
      if (readThreadId(params) !== threadId) {
        return;
      }

      if (method === 'thread/tokenUsage/updated') {
        const metering = readTurnTokenUsage(params);
        if (metering) usageByTurnId.set(metering.turnId, metering.usage);
        return;
      }

      if (method === 'item/agentMessage/delta' && isRecord(params)) {
        const delta = readText(params.delta);
        if (delta) {
          streamedText += delta;
          turn.onTextDelta?.(delta);
        }
        return;
      }

      if (method === 'item/reasoning/textDelta' && isRecord(params)) {
        const delta = readText(params.delta);
        if (delta) {
          hasStreamedReasoningText = true;
          turn.onReasoningDelta?.(delta);
        }
        return;
      }

      if (
        method === 'item/reasoning/summaryTextDelta' &&
        isRecord(params) &&
        !hasStreamedReasoningText
      ) {
        const delta = readText(params.delta);
        if (delta) {
          streamedReasoningSummary += delta;
          turn.onReasoningDelta?.(delta);
        }
        return;
      }

      if (method === 'item/completed') {
        const imageResult = readCompletedImageResult(params);
        if (imageResult) {
          turn.onImageGenerated?.(imageResult);
        }
        if (!hasStreamedReasoningText) {
          const completedSummary = readCompletedReasoningSummary(params);
          if (completedSummary && completedSummary !== streamedReasoningSummary) {
            const missingSummary = completedSummary.startsWith(streamedReasoningSummary)
              ? completedSummary.slice(streamedReasoningSummary.length)
              : `\n${completedSummary}`;
            streamedReasoningSummary = completedSummary;
            turn.onReasoningDelta?.(missingSummary);
          }
        }
        completedText = readAgentMessageText(params) || completedText;
        return;
      }

      if (method !== 'turn/completed') {
        return;
      }

      const status = readTurnStatus(params);
      if (status && status !== 'completed') {
        const failure = readTurnFailure(params);
        rejectTurnCompleted(
          new CodexAppServerError(
            `Codex turn ${status}${failure ? `: ${failure}` : '.'}`,
            'protocol'
          )
        );
        return;
      }
      resolveTurnCompleted(completedText || streamedText);
    });
    cleanupTurnListener = () => {
      unsubscribe();
      cleanupCancellation();
    };
  });

  try {
    const turnResponse = await client.request('turn/start', {
      threadId,
      input: turn.input,
      model: turn.model,
      effort: normalizeCodexReasoningEffort(turn.reasoningEffort),
      summary:
        turn.reasoningEffort === 'none' || turn.reasoningEffort === 'minimal' ? 'none' : 'detailed',
      sandboxPolicy: { type: 'readOnly' },
      ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
    });
    const turnId = readStartedTurnId(turnResponse);
    if (!turnId) {
      throw new CodexAppServerError('Codex did not return a turn id.', 'protocol');
    }

    let rejectCallerCancellation: (error: unknown) => void = () => undefined;
    const callerCancellation = new Promise<never>((_resolve, reject) => {
      rejectCallerCancellation = reject;
    });
    const meteredCompletion = (async () => {
      const outcome = await turnCompleted.then(
        result => ({ result }),
        error => ({ error })
      );
      const usage = usageByTurnId.get(turnId);
      if (usage) {
        await recordWorkflowAiUsage({ ...usage, model: turn.model, provider: 'codex' });
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.result;
    })();
    const result = Promise.race([meteredCompletion, callerCancellation]);
    const settled = meteredCompletion.then(
      () => undefined,
      () => undefined
    );

    let cancellationStarted = false;
    let protocolCloseTimeout: ReturnType<typeof setTimeout> | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;
    const interruptTurn = (callerError: unknown) => {
      if (cancellationStarted) return;
      cancellationStarted = true;
      rejectCallerCancellation(callerError);
      if (turnCompletedSettled) return;

      void client.request('turn/interrupt', { threadId, turnId }).catch(error => {
        console.warn('[Codex app-server] Turn interrupt failed.', { error, threadId, turnId });
      });
      protocolCloseTimeout = setTimeout(() => {
        console.warn('[Codex app-server] Turn did not reach a terminal state after interruption.', {
          threadId,
          turnId,
        });
        rejectTurnCompleted(
          new CodexAppServerError('Codex turn did not stop after interruption.', 'timeout')
        );
      }, CODEX_REQUEST_TIMEOUT_MS);
      protocolCloseTimeout.unref?.();
    };
    const onAbort = () =>
      interruptTurn(turn.signal?.reason ?? new DOMException('Codex turn aborted.', 'AbortError'));
    cleanupCancellation = () => {
      if (protocolCloseTimeout) clearTimeout(protocolCloseTimeout);
      if (turnTimeout) clearTimeout(turnTimeout);
      turn.signal?.removeEventListener('abort', onAbort);
    };
    if (!turnCompletedSettled) {
      turnTimeout = setTimeout(
        () => interruptTurn(new CodexAppServerError('Codex turn timed out.', 'timeout')),
        CODEX_TURN_TIMEOUT_MS
      );
      turnTimeout.unref?.();
      if (turn.signal?.aborted) {
        onAbort();
      } else {
        turn.signal?.addEventListener('abort', onAbort, { once: true });
      }
    }

    return { result, settled };
  } catch (error) {
    cleanupTurnListener();
    throw error;
  }
};

export const runCodexAppServerTurnWithClient = async (
  turn: CodexTurnInput,
  client: CodexJsonRpcClient
): Promise<string> => (await startCodexAppServerTurnWithClient(turn, client)).result;

export const runCodexAppServerTurn = async (turn: CodexTurnInput): Promise<string> => {
  const client = await startCodexAppServerClient(() =>
    spawnCodexAppServer({ allowImageGeneration: turn.allowImageGeneration })
  );
  let execution: CodexTurnExecution;
  try {
    execution = await startCodexAppServerTurnWithClient(turn, client);
  } catch (error) {
    client.close();
    throw error;
  }
  void execution.settled.then(() => client.close());
  return execution.result;
};

export const generateCodexAppServerImage = async ({
  model,
  prompt,
  signal,
}: {
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> => {
  let imageResult = '';
  await runCodexAppServerTurn({
    allowImageGeneration: true,
    developerInstructions:
      'Generate the requested educational image with the built-in image generation capability. Do not use tools other than image generation and do not substitute SVG, HTML, Mermaid, or text art.',
    input: [{ type: 'text', text: prompt }],
    model,
    onImageGenerated: result => {
      imageResult = result;
    },
    reasoningEffort: 'low',
    serviceTier: 'fast',
    signal,
  });
  if (!imageResult) {
    throw new CodexAppServerError('Codex did not return a generated image.', 'protocol');
  }
  return imageResult;
};
