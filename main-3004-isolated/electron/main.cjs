const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');

let viteServer;
let desktopHttpServer;
let mainWindow;
let viteReady = Promise.resolve();
let viteStartupError = null;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const getCredentialFilePath = () => path.join(app.getPath('userData'), 'provider-credentials.bin');

const loadProviderCredentials = () => {
  const credentialPath = getCredentialFilePath();
  if (!fs.existsSync(credentialPath) || !safeStorage.isEncryptionAvailable()) return {};
  try {
    const encrypted = fs.readFileSync(credentialPath);
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Could not read encrypted provider credentials:', error?.message || String(error));
    return {};
  }
};

const saveProviderCredentials = credentials => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const sanitized = Object.fromEntries(
    Object.entries(credentials || {})
      .filter(([providerId, apiKey]) => providerId && typeof apiKey === 'string' && apiKey)
  );
  const credentialPath = getCredentialFilePath();
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, safeStorage.encryptString(JSON.stringify(sanitized)));
  return true;
};

ipcMain.on('desktop-credentials:load', event => {
  event.returnValue = loadProviderCredentials();
});

ipcMain.on('desktop-credentials:save', (event, credentials) => {
  try {
    event.returnValue = saveProviderCredentials(credentials);
  } catch (error) {
    console.error('Could not save encrypted provider credentials:', error?.message || String(error));
    event.returnValue = false;
  }
});

ipcMain.handle('desktop:choose-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '选择图片保存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const directoryPath = fs.realpathSync(result.filePaths[0]);
  return {
    path: directoryPath,
    name: path.basename(directoryPath) || directoryPath,
  };
});

ipcMain.handle('desktop:save-generated-image', async (_event, payload) => {
  const directoryPath = typeof payload?.directoryPath === 'string'
    ? path.resolve(payload.directoryPath)
    : '';
  const filename = path.basename(String(payload?.filename || ''));
  const data = payload?.data;

  if (!directoryPath || !filename || filename === '.' || filename === '..' || !data) {
    throw new Error('保存图片参数无效。');
  }

  const bytes = data instanceof Uint8Array
    ? Buffer.from(data)
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  fs.writeFileSync(path.join(directoryPath, filename), bytes);
  return { saved: true };
});

const getServerAddress = () => {
  const address = desktopHttpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local canvas server did not expose a TCP address.');
  }
  return `http://127.0.0.1:${address.port}`;
};

const serveStaticApp = (distRoot, req, res) => {
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.statusCode = 405;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const resolvedDistRoot = path.resolve(distRoot);
  let filePath = path.resolve(resolvedDistRoot, relativePath);
  const insideDist = filePath === resolvedDistRoot || filePath.startsWith(`${resolvedDistRoot}${path.sep}`);
  if (!insideDist) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stats = fs.statSync(filePath);
    }
  } catch {
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if (!acceptsHtml) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    filePath = path.join(resolvedDistRoot, 'index.html');
    stats = fs.statSync(filePath);
  }

  if (!stats.isFile()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('content-length', String(stats.size));
  res.setHeader('cache-control', path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
};

const getRequestedPort = () => {
  const inlineArg = process.argv.find(arg => arg.startsWith('--port='));
  const portArgIndex = process.argv.indexOf('--port');
  const rawValue = inlineArg?.slice('--port='.length)
    ?? (portArgIndex >= 0 ? process.argv[portArgIndex + 1] : undefined);
  if (rawValue === undefined) return null;

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${rawValue}`);
  }
  return port;
};

const getEphemeralPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      probe.close();
      reject(new Error('Could not allocate a local TCP port.'));
      return;
    }
    probe.close(error => error ? reject(error) : resolve(address.port));
  });
});

const startLocalCanvasServer = async () => {
  // Packaged builds do not load the development .env.local file. Keep the
  // Gemini image timeout within the supported 180-300 second range by
  // default while allowing an explicitly supplied value to override it.
  process.env.XTAPNOW_DESKTOP_RUNTIME = '1';
  process.env.VITE_GEMINI_IMAGE_TIMEOUT_SECONDS ||= '300';
  const configuredRoot = app.getAppPath();
  const root = fs.realpathSync(configuredRoot);
  process.chdir(root);
  const port = getRequestedPort() ?? await getEphemeralPort();
  const distRoot = path.join(root, 'dist');
  if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
    throw new Error(`Desktop build output is missing: ${path.join(distRoot, 'index.html')}`);
  }

  // Serve the already-built UI immediately. Vite is only needed for the API
  // middleware, so warming it in the background removes it from first paint.
  let resolveViteReady;
  viteReady = new Promise(resolve => {
    resolveViteReady = resolve;
  });
  viteStartupError = null;

  desktopHttpServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) {
      await viteReady;
      if (viteStartupError || !viteServer) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { message: '本地接口正在启动，请稍后重试。' } }));
        return;
      }
      viteServer.middlewares(req, res, () => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { message: 'API route not found' } }));
      });
      return;
    }
    serveStaticApp(distRoot, req, res);
  });
  await new Promise((resolve, reject) => {
    desktopHttpServer.once('error', reject);
    desktopHttpServer.listen(port, '127.0.0.1', resolve);
  });

  // Do not make BrowserWindow creation wait for Vite's large bundled config.
  void (async () => {
    try {
      const { createServer } = await import('vite');
      viteServer = await createServer({
        root,
        configFile: path.join(root, 'electron', 'vite.config.bundle.mjs'),
        configLoader: 'native',
        appType: 'custom',
        server: {
          middlewareMode: true,
          hmr: false,
          watch: null,
          fs: {
            strict: false,
            allow: Array.from(new Set([configuredRoot, root])),
          },
        },
        clearScreen: false,
      });
    } catch (error) {
      viteStartupError = error;
      console.error('Could not start local API middleware:', error?.stack || String(error));
    } finally {
      resolveViteReady();
    }
  })();

  return getServerAddress();
};

const createMainWindow = async () => {
  const serverUrl = await startLocalCanvasServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(serverUrl);
};

const closeLocalCanvasServer = async () => {
  const httpServer = desktopHttpServer;
  desktopHttpServer = null;
  const server = viteServer;
  viteServer = null;
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }
  if (server) await server.close();
};

app.whenReady().then(async () => {
  app.setAppUserModelId('com.xtapnow.canvas3004');
  try {
    await createMainWindow();
  } catch (error) {
    dialog.showErrorBox('X-tapnow 3004 startup failed', error?.stack || String(error));
    await closeLocalCanvasServer();
    app.quit();
  }
});

app.on('before-quit', event => {
  if (!viteServer && !desktopHttpServer) return;
  event.preventDefault();
  closeLocalCanvasServer().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
