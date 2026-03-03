import { spawn, ChildProcess } from 'child_process';
import { ProcessState, ServerConfig } from '../types/index.js';
import { loadServerConfig } from '../config/serverConfig.js';

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

    // First, check if TTS server is already running externally
    console.log('[ProcessManager] Checking for existing TTS server...');
    try {
      const response = await fetch(`http://${this.config.ttsServerHost}:${this.config.ttsServerPort}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      
      if (response.ok) {
        console.log('[ProcessManager] TTS server already running externally!');
        this.state.isRunning = true;
        this.state.isReady = true;
        this.state.startTime = Date.now();
        this.startHealthCheck();
        return true;
      }
    } catch (error) {
      console.log('[ProcessManager] No external TTS server found, attempting to start...');
    }

    console.log('[ProcessManager] Starting TTS server...');
    console.log(`[ProcessManager] Python: ${this.config.pythonExecutable}`);
    console.log(`[ProcessManager] Module: ${this.config.ttsServerModule}`);
    console.log(`[ProcessManager] CWD: ${this.config.ttsServerCwd}`);

    // Set environment variables
    const env = {
      ...process.env,
      TTS_MODEL_NAME: this.config.modelId,
      TTS_DEVICE: this.config.device,
      HF_HOME: this.config.modelCachePath,
      PYTHONUNBUFFERED: '1'
    };

    try {
      this.process = spawn(
        this.config.pythonExecutable,
        ['-m', this.config.ttsServerModule],
        {
          cwd: this.config.ttsServerCwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      this.state.isRunning = true;
      this.state.pid = this.process.pid;
      this.state.startTime = Date.now();

      // Handle stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log(`[TTS stdout] ${output.trim()}`);
        
        // Check for startup complete signal
        if (output.includes('Application startup complete') || 
            output.includes('Uvicorn running') ||
            output.includes('Running on')) {
          this.markReady();
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.error(`[TTS stderr] ${output.trim()}`);
        
        // Some servers log startup to stderr
        if (output.includes('Application startup complete') || 
            output.includes('Uvicorn running')) {
          this.markReady();
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`[ProcessManager] TTS server exited with code ${code}, signal ${signal}`);
        this.handleExit(code);
      });

      // Handle process error
      this.process.on('error', (err) => {
        console.error('[ProcessManager] Failed to start TTS server:', err);
        this.state.lastError = err.message;
        this.handleExit(1);
      });

      // Set startup timeout
      this.startupTimeout = setTimeout(() => {
        if (!this.state.isReady) {
          console.warn('[ProcessManager] Startup timeout reached');
          if (this.config.restartOnCrash && this.state.restartAttempts < this.config.maxRestartAttempts) {
            this.restart();
          }
        }
      }, this.config.startupTimeoutMs);

      return true;
    } catch (error: any) {
      console.error('[ProcessManager] Failed to spawn TTS server:', error);
      this.state.lastError = error.message;
      return false;
    }
  }

  private markReady(): void {
    if (this.state.isReady) return;
    
    console.log('[ProcessManager] TTS server is ready!');
    this.state.isReady = true;
    this.state.restartAttempts = 0;
    
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }

    // Start health check
    this.startHealthCheck();
    
    // Notify callbacks
    this.onReadyCallbacks.forEach(cb => cb());
  }

  private handleExit(code: number | null): void {
    const wasReady = this.state.isReady;
    
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

    // Notify exit callbacks
    this.onExitCallbacks.forEach(cb => cb(code));

    // Auto-restart if configured and not a clean exit
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
    if (!this.process) return;

    console.log('[ProcessManager] Stopping TTS server...');
    
    return new Promise((resolve) => {
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
      if (!this.state.isRunning) return;

      try {
        const response = await fetch(`http://${this.config.ttsServerHost}:${this.config.ttsServerPort}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
          console.warn('[ProcessManager] Health check failed:', response.status);
        }
      } catch (error) {
        console.warn('[ProcessManager] Health check error:', error);
        // Don't auto-restart on health check failure - the process might still be recovering
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

// Singleton instance
export const processManager = new ProcessManager();
