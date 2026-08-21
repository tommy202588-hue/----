import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

process.env.XTAPNOW_DESKTOP_RUNTIME = '1';
process.env.VITE_GEMINI_IMAGE_TIMEOUT_SECONDS ||= '300';

const readRequestedPort = () => {
  const inlineArg = process.argv.find(argument => argument.startsWith('--port='));
  const portIndex = process.argv.indexOf('--port');
  const rawPort = inlineArg?.slice('--port='.length)
    ?? (portIndex >= 0 ? process.argv[portIndex + 1] : undefined)
  ?? '3004';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }
  return port;
};

const isPortAvailable = port => new Promise(resolve => {
  const probe = net.createServer();
  probe.unref();
  probe.once('error', () => resolve(false));
  probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
});

const findAvailablePort = async preferredPort => {
  for (let port = preferredPort; port <= Math.min(preferredPort + 20, 65535); port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found between ${preferredPort} and ${preferredPort + 20}.`);
};

const getLanAddresses = () => Object.values(os.networkInterfaces())
  .flatMap(addresses => addresses || [])
  .filter(address => address.family === 'IPv4' && !address.internal)
  .map(address => address.address);

const preferredPort = readRequestedPort();
const port = await findAvailablePort(preferredPort);
const { createServer } = await import('vite');

const viteServer = await createServer({
  root: packageRoot,
  configFile: path.join(packageRoot, 'vite.config.ts'),
  appType: 'spa',
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    hmr: false,
    watch: null,
    fs: {
      strict: true,
      allow: [packageRoot],
    },
  },
  clearScreen: false,
});

await viteServer.listen();

const localUrl = `http://localhost:${port}`;
console.log('');
console.log('X-tapnow 3004 local package is running.');
console.log(`Local: ${localUrl}`);
getLanAddresses().forEach(address => console.log(`LAN:   http://${address}:${port}`));
console.log('Close this window or press Ctrl+C to stop the service.');
console.log('');

const openBrowser = url => {
  if (process.platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, error => {
      if (error) console.warn(`Open the browser manually: ${url}`);
    });
    return;
  }

  if (process.platform === 'darwin') {
    execFile('open', [url], error => {
      if (error) console.warn(`Open the browser manually: ${url}`);
    });
    return;
  }

  execFile('xdg-open', [url], error => {
    if (error) console.warn(`Open the browser manually: ${url}`);
  });
};

if (process.env.XTAPNOW_NO_BROWSER !== '1') {
  openBrowser(localUrl);
}

let isClosing = false;
const closeServer = async exitCode => {
  if (isClosing) return;
  isClosing = true;
  await viteServer.close();
  process.exit(exitCode);
};

process.on('SIGINT', () => void closeServer(0));
process.on('SIGTERM', () => void closeServer(0));
process.on('uncaughtException', error => {
  console.error(error);
  void closeServer(1);
});
process.on('unhandledRejection', error => {
  console.error(error);
  void closeServer(1);
});
