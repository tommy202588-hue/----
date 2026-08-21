const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const logPath = path.join(projectRoot, 'dev-3004.log');
const errorLogPath = path.join(projectRoot, 'dev-3004.err.log');

let child = null;
let stopping = false;

const writeSupervisorLog = (message) => {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
};

const isServerHealthy = () => new Promise((resolve) => {
  const request = http.get('http://127.0.0.1:3004/', (response) => {
    response.resume();
    resolve(response.statusCode >= 200 && response.statusCode < 500);
  });
  request.setTimeout(2000, () => request.destroy());
  request.once('error', () => resolve(false));
});

const ensureStarted = async () => {
  if (stopping || child) return;
  if (await isServerHealthy()) {
    setTimeout(ensureStarted, 5000);
    return;
  }
  start();
};

const start = () => {
  const stdout = fs.openSync(logPath, 'a');
  const stderr = fs.openSync(errorLogPath, 'a');

  child = spawn(process.execPath, [
    viteEntry,
    '--host', '0.0.0.0',
    '--port', '3004',
    '--strictPort',
  ], {
    cwd: projectRoot,
    env: { ...process.env, VITE_DEV_SERVER_PORT: '3004' },
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });

  fs.closeSync(stdout);
  fs.closeSync(stderr);
  writeSupervisorLog(`Started Vite process ${child.pid}.`);

  child.once('exit', (code, signal) => {
    writeSupervisorLog(`Vite exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`);
    child = null;
    if (!stopping) setTimeout(ensureStarted, 1000);
  });
};

const stop = () => {
  stopping = true;
  if (child) child.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', (error) => {
  fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] Supervisor error: ${error.stack || error}\n`);
  setTimeout(start, 1000);
});

writeSupervisorLog(`Supervisor started as process ${process.pid}.`);
ensureStarted();
