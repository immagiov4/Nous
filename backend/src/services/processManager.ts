import { spawn, type ChildProcess } from 'node:child_process';

import type { ProcessState, ServerConfig } from '../types/index.js';

import { loadServerConfig } from '../config/serverConfig.js';
import { getErrorMessage } from '../utils/errors.js';
import { checkTtsHealth } from './ttsHealth.js';

class ProcessManager {
  private process: ChildProcess | null = null;
  private state: ProcessState = {
    isRunning: false,
    isReady: false,
    restartAttempts: 0
  };
  private config: ServerConfig;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private startupTimeout: NodeJS.Timeout | null = null;
  private onReadyCallbacks: (() => void)[] = [];
  private onExitCallbacks: ((code: number | null) => void)[] = [];

  constructor() {
    this.config = loadServerConfig();
  }

  getState(): ProcessState {
    return { ...this.state };
  }

  async start(): Promise<boolean> {
    if (this.state.isRunning) {
      console.log('[ProcessManager] TTS server already running');
      return true;
    }

    console.log('[ProcessManager] Checking for existing TTS server...');
    try {
      const health = await checkTtsHealth(this.config);

      if (health.healthy) {
        console.log('[ProcessManager] TTS server already running externally!');
        this.state.isRunning = true;
        this.state.isReady = true;
        this.state.startTime = Date.now();
        this.startHealthCheck();
        return true;
      }
    } catch (_error) {
      console.log('[ProcessManager] No external TTS server found.');
      console.log('[ProcessManager] To start TTS server, run: npm run dev:tts');
      this.state.isRunning = false;
      this.state.isReady = false;
      return false;
    }

    console.log('[ProcessManager] Starting TTS server...');
    console.log(`[ProcessManager] Python: ${this.config.pythonExecutable}`);
    console.log(`[ProcessManager] Module: ${this.config.ttsServerModule}`);
    console.log(`[ProcessManager] CWD: ${this.config.ttsServerCwd}`);

    const selectedModel = process.env.TTS_MODEL_NAME || this.config.modelId;

    const env = {
      ...process.env,
      TTS_BACKEND: 'official',
      TTS_MODEL_NAME: selectedModel,
      FORCED_VOICE_PROFILE: 'Mario',
      TTS_DEVICE: this.config.device,
      HF_HOME: this.config.modelCachePath,
      PYTHONUNBUFFERED: '1',
    };

    console.log(`[ProcessManager] TTS model: ${selectedModel}`);

    try {
      this.process = spawn(
        this.config.pythonExecutable,
        ['-m', this.config.ttsServerModule],
        {
          cwd: this.config.ttsServerCwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      this.state.isRunning = true;
      this.state.pid = this.process.pid;
      this.state.startTime = Date.now();

      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log(`[TTS stdout] ${output.trim()}`);

        if (output.includes('Application startup complete') ||
            output.includes('Uvicorn running') ||
            output.includes('Running on')) {
          this.markReady();
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.error(`[TTS stderr] ${output.trim()}`);

        if (output.includes('Application startup complete') ||
            output.includes('Uvicorn running')) {
          this.markReady();
        }
      });

      this.process.on('exit', (code, signal) => {
        console.log(`[ProcessManager] TTS server exited with code ${code}, signal ${signal}`);
        this.handleExit(code);
      });

      this.process.on('error', (err) => {
        console.error('[ProcessManager] Failed to start TTS server:', err);
        this.state.lastError = err.message;
        this.handleExit(1);
      });

      this.startupTimeout = setTimeout(() => {
        if (!this.state.isReady) {
          console.warn('[ProcessManager] Startup timeout reached');
          if (this.config.restartOnCrash && this.state.restartAttempts < this.config.maxRestartAttempts) {
            this.restart();
          }
        }
      }, this.config.startupTimeoutMs);

      return true;
    } catch (error) {
      console.error('[ProcessManager] Failed to spawn TTS server:', error);
      this.state.lastError = getErrorMessage(error, 'Failed to spawn TTS server');
      return false;
    }
  }

  private markReady(): void {
    if (this.state.isReady) {
      return;
    }

    console.log('[ProcessManager] TTS server is ready!');
    this.state.isReady = true;
    this.state.restartAttempts = 0;

    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }

    this.startHealthCheck();

    this.onReadyCallbacks.forEach((callback) => {
      callback();
    });
  }

  private handleExit(code: number | null): void {
    this.state.isRunning = false;
    this.state.isReady = false;
    this.state.pid = undefined;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }

    this.onExitCallbacks.forEach((callback) => {
      callback(code);
    });

    if (this.config.restartOnCrash && code !== 0 && code !== null) {
      if (this.state.restartAttempts < this.config.maxRestartAttempts) {
        console.log(`[ProcessManager] Scheduling restart (attempt ${this.state.restartAttempts + 1}/${this.config.maxRestartAttempts})`);
        setTimeout(() => this.restart(), 5000);
      } else {
        console.error('[ProcessManager] Max restart attempts reached');
      }
    }
  }

  private async restart(): Promise<void> {
    console.log('[ProcessManager] Restarting TTS server...');
    this.state.restartAttempts++;
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.start();
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    console.log('[ProcessManager] Stopping TTS server...');

    await new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        console.log('[ProcessManager] Force killing TTS server...');
        this.process?.kill('SIGKILL');
      }, 5000);

      this.process.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this.state.isRunning = false;
        this.state.isReady = false;
        resolve();
      });

      this.process.kill('SIGTERM');
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.state.isRunning) {
        return;
      }

      try {
        const health = await checkTtsHealth(this.config);

        if (!health.healthy) {
          console.warn('[ProcessManager] Health check failed:', health.message);
        }
      } catch (error) {
        console.warn('[ProcessManager] Health check error:', getErrorMessage(error));
      }
    }, this.config.healthCheckIntervalMs);
  }

  onReady(callback: () => void): void {
    this.onReadyCallbacks.push(callback);
    if (this.state.isReady) {
      callback();
    }
  }

  onExit(callback: (code: number | null) => void): void {
    this.onExitCallbacks.push(callback);
  }
}

export const processManager = new ProcessManager();
