#!/usr/bin/env node
/**
 * Lifecycle Manager for Lumina Deep Reader
 *
 * This script manages the entire application lifecycle:
 * 1. Kills any existing processes on the configured backend/frontend ports
 * 2. Starts the backend (which spawns the TTS Python server)
 * 3. Starts the frontend Vite dev server
 * 4. Handles graceful shutdown on CTRL+C
 */

import { exec, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { getBackendDisplayHost, getBackendRuntimeConfig } from './server-config.js';

const isWindows = platform() === 'win32';
const backendConfig = getBackendRuntimeConfig();

// Process references
let backendProcess = null;
let frontendProcess = null;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(prefix, message, color = colors.reset) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(
    `${colors.cyan}[${timestamp}]${colors.reset} ${color}[${prefix}]${colors.reset} ${message}`
  );
}

/**
 * Kill process on a specific port
 */
function killPort(port) {
  return new Promise(resolve => {
    const command = isWindows ? `netstat -ano | findstr :${port}` : `lsof -ti:${port}`;

    exec(command, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve();
        return;
      }

      if (isWindows) {
        // Parse Windows netstat output
        const lines = stdout.trim().split('\n');
        const pids = new Set();
        lines.forEach(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !Number.isNaN(Number(pid))) {
            pids.add(pid);
          }
        });

        pids.forEach(pid => {
          exec(`taskkill /F /PID ${pid}`, err => {
            if (!err) {
              log('Kill', `Killed process ${pid} on port ${port}`, colors.yellow);
            }
          });
        });
        resolve();
      } else {
        // Unix: kill directly
        const pids = stdout.trim().split('\n');
        pids.forEach(pid => {
          if (pid) {
            exec(`kill -9 ${pid}`, err => {
              if (!err) {
                log('Kill', `Killed process ${pid} on port ${port}`, colors.yellow);
              }
            });
          }
        });
        resolve();
      }
    });
  });
}

/**
 * Kill all known ports
 */
async function killAllPorts() {
  log('Lifecycle', 'Cleaning up existing processes...', colors.yellow);
  await Promise.all([
    // DON'T kill port 8880 - user may have TTS server running manually
    killPort(backendConfig.backendPort), // Backend
    killPort(5173), // Frontend
  ]);
  // Wait a bit for processes to die
  await new Promise(r => setTimeout(r, 1000));
}

/**
 * Start the backend server
 */
function startBackend() {
  log('Backend', 'Starting Node.js backend...', colors.green);

  const cmd = isWindows ? 'npm.cmd' : 'npm';
  backendProcess = spawn(cmd, ['run', 'dev:backend'], {
    stdio: 'inherit',
    shell: true,
  });

  backendProcess.on('error', err => {
    log('Backend', `Failed to start: ${err.message}`, colors.red);
  });

  backendProcess.on('exit', code => {
    if (code !== 0 && code !== null) {
      log('Backend', `Exited with code ${code}`, colors.red);
    }
  });
}

/**
 * Start the frontend server
 */
function startFrontend() {
  log('Frontend', 'Starting Vite dev server...', colors.green);

  const cmd = isWindows ? 'npm.cmd' : 'npm';
  frontendProcess = spawn(cmd, ['run', 'dev:frontend'], {
    stdio: 'inherit',
    shell: true,
  });

  frontendProcess.on('error', err => {
    log('Frontend', `Failed to start: ${err.message}`, colors.red);
  });

  frontendProcess.on('exit', code => {
    if (code !== 0 && code !== null) {
      log('Frontend', `Exited with code ${code}`, colors.red);
    }
  });
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('\n');
  log('Lifecycle', 'Shutting down...', colors.yellow);

  const killProcess = (proc, name) => {
    return new Promise(resolve => {
      if (!proc) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        log(name, 'Force killing...', colors.red);
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        log(name, 'Stopped', colors.yellow);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  };

  await Promise.all([
    killProcess(frontendProcess, 'Frontend'),
    killProcess(backendProcess, 'Backend'),
  ]);

  // Kill any remaining processes on ports
  await killAllPorts();

  log('Lifecycle', 'Goodbye!', colors.green);
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(
    `${colors.bright}${colors.magenta}  Lumina Deep Reader - Development Server${colors.reset}`
  );
  console.log(`${'='.repeat(60)}\n`);

  // Handle CTRL+C
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Kill existing processes
  await killAllPorts();

  // Start services
  startBackend();

  // Wait a bit for backend to start
  await new Promise(r => setTimeout(r, 2000));

  startFrontend();

  log('Lifecycle', 'All services started!', colors.green);
  log('Lifecycle', 'Press CTRL+C to stop all services', colors.yellow);
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${colors.cyan}  Frontend:  http://localhost:5173${colors.reset}`);
  console.log(
    `${colors.cyan}  Backend:   http://${getBackendDisplayHost(backendConfig.backendHost)}:${backendConfig.backendPort}${colors.reset}`
  );
  console.log(`${colors.cyan}  TTS API:   http://localhost:8880${colors.reset}`);
  console.log(`${'-'.repeat(60)}\n`);
}

main().catch(err => {
  log('Lifecycle', `Fatal error: ${err.message}`, colors.red);
  process.exit(1);
});
