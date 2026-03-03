#!/usr/bin/env node
/**
 * Stop all Lumina Deep Reader services
 * 
 * Kills processes on ports 8000, 3001, 5173
 */

import { exec } from 'child_process';
import { platform } from 'os';

const isWindows = platform() === 'win32';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}[Stop]${colors.reset} ${message}`);
}

function killPort(port) {
  return new Promise((resolve) => {
    const command = isWindows
      ? `netstat -ano | findstr :${port}`
      : `lsof -ti:${port}`;
    
    exec(command, (error, stdout) => {
      if (error || !stdout.trim()) {
        log(`No process found on port ${port}`, colors.yellow);
        resolve(false);
        return;
      }

      if (isWindows) {
        const lines = stdout.trim().split('\n');
        const pids = new Set();
        lines.forEach(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(pid)) {
            pids.add(pid);
          }
        });
        
        let killed = false;
        pids.forEach(pid => {
          exec(`taskkill /F /PID ${pid}`, (err) => {
            if (!err) {
              log(`Killed process ${pid} on port ${port}`, colors.green);
              killed = true;
            }
          });
        });
        resolve(killed);
      } else {
        const pids = stdout.trim().split('\n');
        let killed = false;
        pids.forEach(pid => {
          if (pid) {
            exec(`kill -9 ${pid}`, (err) => {
              if (!err) {
                log(`Killed process ${pid} on port ${port}`, colors.green);
                killed = true;
              }
            });
          }
        });
        resolve(killed);
      }
    });
  });
}

async function stopAll() {
  console.log('\n' + '='.repeat(50));
  console.log('  Stopping Lumina Deep Reader Services');
  console.log('='.repeat(50) + '\n');

  const ports = [
    { port: 8000, name: 'TTS Server' },
    { port: 3001, name: 'Backend' },
    { port: 5173, name: 'Frontend' }
  ];

  for (const { port, name } of ports) {
    log(`Checking ${name} (port ${port})...`, colors.cyan);
    await killPort(port);
  }

  console.log('\n' + '-'.repeat(50));
  log('All services stopped.', colors.green);
  console.log('-'.repeat(50) + '\n');
}

stopAll().catch((err) => {
  log(`Error: ${err.message}`, colors.red);
  process.exit(1);
});
