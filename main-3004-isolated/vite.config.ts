import path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const readRequestBody = (req: any) => new Promise<string>((resolve, reject) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const showWindowsFolderPicker = () => new Promise<string>((resolve, reject) => {
  const foregroundHelper = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class FolderPickerForeground {',
    '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder className, int count);',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  public static void BringDialogToFront(int processId) {',
    '    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {',
    '      uint ownerProcessId;',
    '      GetWindowThreadProcessId(hWnd, out ownerProcessId);',
    '      if (ownerProcessId == processId && IsWindowVisible(hWnd)) {',
    '        var className = new StringBuilder(64);',
    '        GetClassName(hWnd, className, className.Capacity);',
    '        if (className.ToString() == "#32770") {',
    '          SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0043);',
    '          SetForegroundWindow(hWnd);',
    '        }',
    '      }',
    '      return true;',
    '    }, IntPtr.Zero);',
    '  }',
    '}'
  ].join(' ');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `Add-Type -TypeDefinition '${foregroundHelper}'`,
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.Text = "选择图片保存文件夹"',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $true',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Size = New-Object System.Drawing.Size(2, 2)',
    '$owner.Opacity = 0.01',
    '$owner.Show()',
    '$owner.BringToFront()',
    '$owner.Activate()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择图片保存文件夹"',
    '$dialog.ShowNewFolderButton = $true',
    '$foregroundTimer = New-Object System.Windows.Forms.Timer',
    '$foregroundTimer.Interval = 200',
    '$foregroundTimer.Add_Tick({ [FolderPickerForeground]::BringDialogToFront($PID) })',
    '$foregroundTimer.Start()',
    '$result = $dialog.ShowDialog($owner)',
    '$foregroundTimer.Stop()',
    '$foregroundTimer.Dispose()',
    '$owner.Close()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write("XTPATH:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))) }'
  ].join('; ');

  execFile('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    const encodedPath = stdout.trim();
    if (!encodedPath) {
      resolve('');
      return;
    }

    resolve(encodedPath.startsWith('XTPATH:')
      ? Buffer.from(encodedPath.slice('XTPATH:'.length), 'base64').toString('utf8')
      : encodedPath);
  });
});

const getWindowsHttpProxy = () => {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  }

  try {
    const settingsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const serverOutput = execFileSync('reg', ['query', settingsKey, '/v', 'ProxyServer'], { encoding: 'utf8' });
    const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    const proxyServer = match?.[1]?.trim();
    if (!proxyServer) return '';

    const normalized = proxyServer.includes('=')
      ? (proxyServer.match(/(?:https|http)=([^;]+)/i)?.[1] || proxyServer.split(';')[0].split('=').pop() || '')
      : proxyServer;

    return normalized ? (normalized.startsWith('http') ? normalized : `http://${normalized}`) : '';
  } catch {
    return '';
  }
};

const collectResponse = (response: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  response.on('end', () => resolve(Buffer.concat(chunks)));
  response.on('error', reject);
});

const isAllowedGeminiTarget = (targetUrl: URL) => {
  if (targetUrl.protocol !== 'https:') return false;
  const hostname = targetUrl.hostname.toLowerCase();
  return hostname === 'api.openlux.ai'
    || hostname === 'generativelanguage.googleapis.com'
    || hostname.endsWith('.googleapis.com');
};

const clampGeminiTimeoutSeconds = (rawValue?: string) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 180;
  return Math.min(300, Math.max(180, Math.round(parsed)));
};

const streamDirectGeminiRequest = (
  targetUrl: string,
  apiKey: string,
  payload: unknown,
  authHeader: string,
  res: http.ServerResponse,
  timeoutSeconds: number
) => new Promise<void>((resolve, reject) => {
  const target = new URL(targetUrl);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    [authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'authorization']:
      authHeader === 'x-goog-api-key' ? apiKey : `Bearer ${apiKey}`,
  };
  let responseStarted = false;
  let receivedBytes = 0;
  let requestId = '';

  const request = https.request({
    hostname: target.hostname,
    port: Number(target.port || 443),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: requestHeaders,
    timeout: timeoutSeconds * 1000,
  }, upstream => {
    responseStarted = true;
    requestId = String(upstream.headers['x-api-request-id'] || upstream.headers['x-request-id'] || '');
    res.statusCode = upstream.statusCode || 502;
    res.setHeader('content-type', String(upstream.headers['content-type'] || 'application/json; charset=utf-8'));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-canvas-upstream-route', 'server-direct');
    if (requestId) res.setHeader('x-canvas-upstream-request-id', requestId);

    upstream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      res.write(buffer);
    });
    upstream.once('end', () => {
      res.end();
      console.info('[Gemini proxy] upstream response completed', {
        status: upstream.statusCode || 502,
        requestId: requestId || '(none)',
        receivedBytes,
      });
      resolve();
    });
    upstream.once('error', error => {
      console.warn('[Gemini proxy] upstream response interrupted', {
        status: upstream.statusCode || 502,
        requestId: requestId || '(none)',
        receivedBytes,
        error: error instanceof Error ? error.message : String(error),
      });
      if (res.destroyed) {
        reject(error);
        return;
      }
      res.destroy(error instanceof Error ? error : undefined);
      reject(error);
    });
  });

  request.once('timeout', () => request.destroy(new Error(`Gemini upstream request timed out after ${timeoutSeconds}s.`)));
  request.once('error', error => {
    if (!responseStarted && !res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: {
          message: `Gemini direct proxy connection failed: ${error instanceof Error ? error.message : String(error)}`,
          type: 'gemini_direct_proxy_error',
          targetUrl,
        },
      }));
    }
    reject(error);
  });

  request.write(body);
  request.end();
});

const createHttpsTunnel = (targetUrl: URL, proxyUrl: URL) => new Promise<tls.TLSSocket>((resolve, reject) => {
  const connectRequest = http.request({
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port || 80),
    method: 'CONNECT',
    path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
    headers: {
      Host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
    },
  });

  connectRequest.once('connect', (response, socket) => {
    if (response.statusCode !== 200) {
      socket.destroy();
      reject(new Error(`Proxy CONNECT failed with status ${response.statusCode}`));
      return;
    }

    const secureSocket = tls.connect({
      socket: socket as net.Socket,
      servername: targetUrl.hostname,
    });

    secureSocket.once('secureConnect', () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });

  connectRequest.once('error', reject);
  connectRequest.end();
});

const forwardJsonRequest = async (
  targetUrl: string,
  apiKey: string,
  payload: unknown,
  proxyServer: string,
  authHeader: string = 'authorization'
) => {
  const target = new URL(targetUrl);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
  };
  headers[authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'authorization'] =
    authHeader === 'x-goog-api-key' ? apiKey : `Bearer ${apiKey}`;

  if (proxyServer) {
    const curlResponse = await forwardJsonRequestWithCurl(targetUrl, apiKey, payload, proxyServer, authHeader);
    if (curlResponse) {
      const isEmptyProxyGatewayError = [502, 503, 504].includes(curlResponse.statusCode)
        && curlResponse.body.length === 0;
      if (!isEmptyProxyGatewayError) return curlResponse;

      console.warn(`[Local API proxy] System proxy returned empty HTTP ${curlResponse.statusCode}; retrying direct.`);
      const directUpstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body,
      });
      return {
        statusCode: directUpstream.status,
        headers: Object.fromEntries(directUpstream.headers.entries()),
        body: Buffer.from(await directUpstream.arrayBuffer()),
      };
    }

    const proxy = new URL(proxyServer);

    if (target.protocol === 'https:' && proxy.protocol.startsWith('http')) {
      const tunnelSocket = await createHttpsTunnel(target, proxy);

      return await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const request = https.request({
          host: target.hostname,
          port: Number(target.port || 443),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers,
          createConnection: () => tunnelSocket,
        }, async (response) => {
          try {
            resolve({
              statusCode: response.statusCode || 502,
              headers: response.headers,
              body: await collectResponse(response),
            });
          } catch (error) {
            reject(error);
          }
        });

        request.once('error', reject);
        request.write(body);
        request.end();
      });
    }

    if (target.protocol === 'http:' && proxy.protocol.startsWith('http')) {
      return await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const request = http.request({
          host: proxy.hostname,
          port: Number(proxy.port || 80),
          path: target.toString(),
          method: 'POST',
          headers: {
            ...headers,
            Host: target.host,
          },
        }, async (response) => {
          try {
            resolve({
              statusCode: response.statusCode || 502,
              headers: response.headers,
              body: await collectResponse(response),
            });
          } catch (error) {
            reject(error);
          }
        });

        request.once('error', reject);
        request.write(body);
        request.end();
      });
    }
  }

  const upstream = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body,
  });

  return {
    statusCode: upstream.status,
    headers: Object.fromEntries(upstream.headers.entries()),
    body: Buffer.from(await upstream.arrayBuffer()),
  };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const forwardJsonRequestWithRetry = async (
  targetUrl: string,
  apiKey: string,
  payload: unknown,
  proxyServer: string,
  authHeader: string = 'authorization'
) => {
  let upstream = await forwardJsonRequest(targetUrl, apiKey, payload, proxyServer, authHeader);

  if (upstream.statusCode === 200 && upstream.body.length === 0) {
    await sleep(1000);
    upstream = await forwardJsonRequest(targetUrl, apiKey, payload, proxyServer, authHeader);
  }

  if (upstream.statusCode === 200 && upstream.body.length === 0) {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({
        error: {
          message: '上游接口返回 HTTP 200，但响应体为空；重试后仍没有返回图片数据。',
          type: 'empty_upstream_response',
          targetUrl,
          proxy: proxyServer || '(none)',
          hint: '请确认 API Key、模型名和接口服务是否支持通过 /v1/chat/completions 返回图片 URL 或 base64。',
        },
      })),
    };
  }

  return upstream;
};

const dataUrlToBlob = (dataUrl: string, fallbackMime = 'image/png') => {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return new Blob([dataUrl], { type: fallbackMime });
  }

  const mimeType = match[1] || fallbackMime;
  const isBase64 = !!match[2];
  const rawData = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(rawData, 'base64')
    : Buffer.from(decodeURIComponent(rawData), 'utf8');

  return new Blob([buffer], { type: mimeType });
};

const forwardImagesProxyRequest = async (
  targetUrl: string,
  apiKey: string,
  payloadType: 'json' | 'form-data',
  payload: any,
  proxyServer: string
) => {
  if (payloadType !== 'form-data') {
    return await forwardJsonRequestWithRetry(targetUrl, apiKey, payload, proxyServer);
  }

  const form = new FormData();
  const entries = Array.isArray(payload) ? payload : [];

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;

    if (entry.kind === 'file') {
      const blob = dataUrlToBlob(String(entry.dataUrl || ''), String(entry.mimeType || 'image/png'));
      form.append(entry.name, blob, String(entry.fileName || 'image.png'));
    } else {
      form.append(entry.name, String(entry.value ?? ''));
    }
  }

  const upstream = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  return {
    statusCode: upstream.status,
    headers: Object.fromEntries(upstream.headers.entries()),
    body: Buffer.from(await upstream.arrayBuffer()),
  };
};

const forwardJsonRequestWithCurl = (
  targetUrl: string,
  apiKey: string,
  payload: unknown,
  proxyServer: string,
  authHeader: string = 'authorization'
) => new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer } | null>((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const payloadFile = path.join(
    os.tmpdir(),
    `xtapnow-openai-payload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  writeFileSync(payloadFile, body);

  const args = [
    '-sS',
    '--http1.1',
    '-x', proxyServer,
    '-X', 'POST',
    '-H', 'content-type: application/json',
    '-H', authHeader === 'x-goog-api-key' ? `x-goog-api-key: ${apiKey}` : `authorization: Bearer ${apiKey}`,
    '--data-binary', `@${payloadFile}`,
    '-w', '\n__X_TAPNOW_HTTP_STATUS__:%{http_code}',
    targetUrl,
  ];

  const child = spawn('curl.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const cleanup = () => {
    try {
      unlinkSync(payloadFile);
    } catch { }
  };

  child.once('error', (error: any) => {
    cleanup();
    if (error?.code === 'ENOENT') {
      resolve(null);
      return;
    }
    reject(error);
  });
  child.once('close', (code) => {
    cleanup();
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const marker = Buffer.from('\n__X_TAPNOW_HTTP_STATUS__:');
    const markerIndex = stdout.lastIndexOf(marker);

    if (markerIndex === -1) {
      reject(new Error(`curl proxy request failed${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    const responseBody = stdout.subarray(0, markerIndex);
    const statusText = stdout.subarray(markerIndex + marker.length).toString('utf8').trim();
    const statusCode = Number(statusText) || 502;

    if (code && statusCode === 0) {
      reject(new Error(`curl proxy request failed with code ${code}${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    resolve({
      statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: responseBody,
    });
  });

});

const forwardGetRequestWithCurl = (
  targetUrl: string,
  apiKey: string,
  providerType: string,
  proxyServer: string
) => new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer } | null>((resolve, reject) => {
  const authHeader = providerType === 'gemini'
    ? `x-goog-api-key: ${apiKey}`
    : `authorization: Bearer ${apiKey}`;
  const args = [
    '-sS',
    '--http1.1',
    '-x', proxyServer,
    '-H', authHeader,
    '-w', '\n__X_TAPNOW_HTTP_STATUS__:%{http_code}\n__X_TAPNOW_CONTENT_TYPE__:%{content_type}',
    targetUrl,
  ];

  const child = spawn('curl.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.once('error', (error: any) => {
    if (error?.code === 'ENOENT') {
      resolve(null);
      return;
    }
    reject(error);
  });
  child.once('close', (code) => {
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const statusMarker = Buffer.from('\n__X_TAPNOW_HTTP_STATUS__:');
    const typeMarker = Buffer.from('\n__X_TAPNOW_CONTENT_TYPE__:');
    const statusIndex = stdout.lastIndexOf(statusMarker);
    const typeIndex = stdout.lastIndexOf(typeMarker);

    if (statusIndex === -1 || typeIndex === -1 || typeIndex < statusIndex) {
      reject(new Error(`curl model list failed${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    const responseBody = stdout.subarray(0, statusIndex);
    const statusText = stdout.subarray(statusIndex + statusMarker.length, typeIndex).toString('utf8').trim();
    const contentType = stdout.subarray(typeIndex + typeMarker.length).toString('utf8').trim();
    const statusCode = Number(statusText) || 502;

    if (code && statusCode === 0) {
      reject(new Error(`curl model list failed with code ${code}${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    resolve({
      statusCode,
      headers: { 'content-type': contentType || 'application/json; charset=utf-8' },
      body: responseBody,
    });
  });
});

const normalizeModelListUrl = (baseUrl: string, providerType: string) => {
  let base = (baseUrl || '').trim();
  if (!base) {
    base = providerType === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : 'https://api.openai.com';
  }
  if (base.endsWith('/')) base = base.slice(0, -1);
  base = base
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1beta\/models$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');

  return providerType === 'gemini'
    ? `${base}/v1beta/models`
    : `${base}/v1/models`;
};

const extractModelIds = (data: any) => {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().replace(/^models\//, '');
    if (trimmed) ids.add(trimmed);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add((item as any).id || (item as any).name);
    });
  }

  if (Array.isArray(data?.data)) {
    data.data.forEach((item: any) => add(item?.id || item?.name));
  }

  if (Array.isArray(data?.models)) {
    data.models.forEach((item: any) => add(item?.id || item?.name));
  }

  return Array.from(ids);
};

const downloadBinaryWithCurl = (
  targetUrl: string,
  proxyServer: string
) => new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer } | null>((resolve, reject) => {
  const args = [
    '-sS',
    '-L',
    '--http1.1',
    '-x', proxyServer,
    '-w', '\n__X_TAPNOW_HTTP_STATUS__:%{http_code}\n__X_TAPNOW_CONTENT_TYPE__:%{content_type}',
    targetUrl,
  ];

  const child = spawn('curl.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.once('error', (error: any) => {
    if (error?.code === 'ENOENT') {
      resolve(null);
      return;
    }
    reject(error);
  });
  child.once('close', (code) => {
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const statusMarker = Buffer.from('\n__X_TAPNOW_HTTP_STATUS__:');
    const typeMarker = Buffer.from('\n__X_TAPNOW_CONTENT_TYPE__:');
    const statusIndex = stdout.lastIndexOf(statusMarker);
    const typeIndex = stdout.lastIndexOf(typeMarker);

    if (statusIndex === -1 || typeIndex === -1 || typeIndex < statusIndex) {
      reject(new Error(`curl download failed${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    const responseBody = stdout.subarray(0, statusIndex);
    const statusText = stdout.subarray(statusIndex + statusMarker.length, typeIndex).toString('utf8').trim();
    const contentType = stdout.subarray(typeIndex + typeMarker.length).toString('utf8').trim();
    const statusCode = Number(statusText) || 502;

    if (code && statusCode === 0) {
      reject(new Error(`curl download failed with code ${code}${stderr ? `: ${stderr}` : ''}`));
      return;
    }

    resolve({
      statusCode,
      headers: { 'content-type': contentType || 'application/octet-stream' },
      body: responseBody,
    });
  });
});

export default defineConfig(({ mode }) => {
  const projectRoot = path.resolve(process.cwd());
  const isDesktopRuntime = process.env.XTAPNOW_DESKTOP_RUNTIME === '1';
  const env = isDesktopRuntime
    ? {
        VITE_GEMINI_IMAGE_TIMEOUT_SECONDS: process.env.VITE_GEMINI_IMAGE_TIMEOUT_SECONDS || '300',
      }
    : loadEnv(mode, '.', '');
  const isPortableBuild = mode === 'portable';
  const uploadProxyTarget = env.VITE_UPLOAD_PROXY_TARGET?.trim();
  const allowBundledCredentials = !isDesktopRuntime && !isPortableBuild;
  const geminiApiKey = allowBundledCredentials
    ? env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || ''
    : '';
  const comflyApiKey = allowBundledCredentials
    ? env.VITE_COMFLY_API_KEY || env.COMFLY_API_KEY || env.VITE_DEFAULT_IMAGE_API_KEY || env.DEFAULT_IMAGE_API_KEY || ''
    : '';
  let selectedSaveDirectory = '';

  return {
    base: isPortableBuild ? './' : '/',
    cacheDir: isDesktopRuntime
      ? path.join(projectRoot, 'node_modules', '.vite-desktop')
      : undefined,
    optimizeDeps: isDesktopRuntime
      ? {
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
          ],
        }
      : undefined,
    build: isPortableBuild
      ? {
          outDir: 'dist-portable',
          emptyOutDir: true,
          cssCodeSplit: false,
          assetsInlineLimit: 0,
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
            },
          },
        }
      : undefined,
    server: {
      port: Number(env.VITE_DEV_SERVER_PORT || 3000),
      host: env.VITE_DEV_SERVER_HOST || '0.0.0.0',
      proxy: uploadProxyTarget
        ? {
            '/api/upload': {
              target: uploadProxyTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },
    plugins: [
      react(),
      {
        name: 'local-openai-chat-proxy',
        configureServer(server) {
          // File System Access API is unavailable on LAN HTTP pages. Let the
          // local Vite host open the native folder picker and receive images.
          server.middlewares.use('/api/choose-save-directory', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            if (process.platform !== 'win32') {
              res.statusCode = 501;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: '当前本地服务仅支持 Windows 系统文件夹选择器，请改用 localhost 或 HTTPS。' } }));
              return;
            }

            try {
              const selectedPath = await showWindowsFolderPicker();

              if (!selectedPath) {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ cancelled: true }));
                return;
              }

              selectedSaveDirectory = path.resolve(selectedPath);
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ name: path.basename(selectedSaveDirectory) || selectedSaveDirectory }));
            } catch (error: any) {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: `打开系统文件夹选择器失败：${error?.message || String(error)}` } }));
            }
          });

          server.middlewares.use('/api/save-generated-image', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            try {
              if (!selectedSaveDirectory) throw new Error('请先选择保存文件夹。');
              const payload = JSON.parse(await readRequestBody(req));
              const filename = path.basename(String(payload?.filename || ''));
              const dataUrl = String(payload?.dataUrl || '');
              if (!filename || filename === '.' || filename === '..' || !dataUrl.startsWith('data:')) {
                throw new Error('保存图片参数无效。');
              }

              const blob = dataUrlToBlob(dataUrl);
              const data = Buffer.from(await blob.arrayBuffer());
              writeFileSync(path.join(selectedSaveDirectory, filename), data);
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ saved: true }));
            } catch (error: any) {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: `保存图片失败：${error?.message || String(error)}` } }));
            }
          });

          server.middlewares.use('/api/openai-download-proxy', async (req, res) => {
            try {
              if (req.method !== 'GET') {
                res.statusCode = 405;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
                return;
              }

              const requestUrl = new URL(req.url || '', 'http://localhost');
              const targetUrl = requestUrl.searchParams.get('url');
              if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing or invalid url' } }));
                return;
              }

              const openaiProxyServer = env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy();
              let upstream: { statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer } | null = null;
              let finalTargetUrl = targetUrl;

              for (let attempt = 0; attempt < 6; attempt += 1) {
                const separator = targetUrl.includes('?') ? '&' : '?';
                finalTargetUrl = attempt === 0
                  ? targetUrl
                  : `${targetUrl}${separator}_tapnow_proxy_retry=${Date.now()}_${attempt}`;

                upstream = openaiProxyServer
                  ? await downloadBinaryWithCurl(finalTargetUrl, openaiProxyServer)
                  : null;

                if (!upstream) break;

                const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
                const isImage = contentType.toLowerCase().startsWith('image/');
                const shouldRetry = [404, 425, 429, 500, 502, 503, 504].includes(upstream.statusCode);
                if (upstream.statusCode >= 200 && upstream.statusCode < 300 && isImage) break;
                if (!shouldRetry) break;

                await sleep(1200 + attempt * 900);
              }

              if (!upstream) {
                const direct = await fetch(finalTargetUrl);
                const body = Buffer.from(await direct.arrayBuffer());
                const contentType = direct.headers.get('content-type') || 'application/octet-stream';
                if (!direct.ok || !contentType.toLowerCase().startsWith('image/')) {
                  res.statusCode = direct.ok ? 502 : direct.status;
                  res.setHeader('content-type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({
                    error: {
                      message: `Image download failed: HTTP ${direct.status}`,
                      type: 'image_download_error',
                      targetUrl: finalTargetUrl,
                      contentType,
                      preview: body.toString('utf8', 0, Math.min(body.length, 300)),
                    },
                  }));
                  return;
                }
                res.statusCode = direct.status;
                res.setHeader('content-type', contentType);
                res.end(body);
                return;
              }

              const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
              if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !contentType.toLowerCase().startsWith('image/')) {
                res.statusCode = upstream.statusCode >= 400 ? upstream.statusCode : 502;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: `Image download failed: HTTP ${upstream.statusCode}`,
                    type: 'image_download_error',
                    targetUrl: finalTargetUrl,
                    proxy: openaiProxyServer || '(none)',
                    contentType,
                    preview: upstream.body.toString('utf8', 0, Math.min(upstream.body.length, 300)),
                  },
                }));
                return;
              }

              res.statusCode = upstream.statusCode;
              res.setHeader('content-type', contentType);
              res.end(upstream.body);
            } catch (error: any) {
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: {
                  message: `Local download proxy failed: ${error?.message || String(error)}`,
                  type: 'local_download_proxy_error',
                  proxy: env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy() || '(none)',
                },
              }));
            }
          });

          server.middlewares.use('/api/openai-chat-proxy', async (req, res) => {
            let lastTargetUrl = '';

            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            try {
              const rawBody = await readRequestBody(req);
              const { targetUrl, apiKey, payload, authHeader } = JSON.parse(rawBody || '{}');
              lastTargetUrl = targetUrl || '';

              if (!targetUrl || !apiKey || !payload) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing targetUrl, apiKey, or payload' } }));
                return;
              }

              const openaiProxyServer = env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy();
              const upstream = await forwardJsonRequestWithRetry(targetUrl, apiKey, payload, openaiProxyServer, authHeader);

              if (upstream.statusCode >= 400 && upstream.body.length === 0) {
                res.statusCode = upstream.statusCode;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: `Upstream API returned HTTP ${upstream.statusCode} with an empty response body.`,
                    type: 'empty_upstream_error_response',
                    targetUrl,
                    proxy: openaiProxyServer || '(none)',
                    model: payload?.model,
                    size: payload?.size,
                    quality: payload?.quality,
                    hint: 'The request reached the local proxy, but the upstream service did not return error details. Check whether the model, API key, size, or upstream service status is valid.',
                  },
                }));
                return;
              }

              res.statusCode = upstream.statusCode;
              res.setHeader('content-type', String(upstream.headers['content-type'] || 'application/json; charset=utf-8'));
              res.end(upstream.body);
            } catch (error: any) {
              const cause = error?.cause;
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: {
                  message: `Local proxy failed: ${error?.message || String(error)}`,
                  type: 'local_proxy_error',
                  targetUrl: lastTargetUrl || undefined,
                  proxy: env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy() || '(none)',
                  cause: cause ? {
                    message: cause.message,
                    code: cause.code,
                    errno: cause.errno,
                    syscall: cause.syscall,
                  } : undefined,
                },
              }));
            }
          });

          server.middlewares.use('/api/gemini-image-proxy', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            let targetUrl = '';
            try {
              const timeoutSeconds = clampGeminiTimeoutSeconds(env.VITE_GEMINI_IMAGE_TIMEOUT_SECONDS);
              const rawBody = await readRequestBody(req);
              const parsed = JSON.parse(rawBody || '{}');
              targetUrl = String(parsed.targetUrl || '');
              const apiKey = String(parsed.apiKey || '');
              const payload = parsed.payload;
              const authHeader = parsed.authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'authorization';
              const target = new URL(targetUrl);

              if (!apiKey || !payload || !isAllowedGeminiTarget(target)) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: 'Invalid Gemini target, API key, or payload. Only approved HTTPS Gemini hosts are allowed.',
                    type: 'invalid_gemini_proxy_request',
                  },
                }));
                return;
              }

              res.setHeader('x-canvas-gemini-timeout-seconds', String(timeoutSeconds));
              await streamDirectGeminiRequest(targetUrl, apiKey, payload, authHeader, res, timeoutSeconds);
            } catch (error: any) {
              if (res.headersSent || res.destroyed) return;
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: {
                  message: `Gemini direct proxy failed: ${error?.message || String(error)}`,
                  type: 'gemini_direct_proxy_error',
                  targetUrl: targetUrl || undefined,
                },
              }));
            }
          });

          server.middlewares.use('/api/openai-images-proxy', async (req, res) => {
            let lastTargetUrl = '';

            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            try {
              const rawBody = await readRequestBody(req);
              const { targetUrl, apiKey, payloadType, payload } = JSON.parse(rawBody || '{}');
              lastTargetUrl = targetUrl || '';

              if (!targetUrl || !apiKey || !payload) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing targetUrl, apiKey, or payload' } }));
                return;
              }

              const openaiProxyServer = env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy();
              const upstream = await forwardImagesProxyRequest(
                targetUrl,
                apiKey,
                payloadType === 'form-data' ? 'form-data' : 'json',
                payload,
                openaiProxyServer
              );

              if (upstream.statusCode >= 400 && upstream.body.length === 0) {
                res.statusCode = upstream.statusCode;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: `Upstream Images API returned HTTP ${upstream.statusCode} with an empty response body.`,
                    type: 'empty_upstream_images_error_response',
                    targetUrl,
                    proxy: openaiProxyServer || '(none)',
                    payloadType: payloadType || 'json',
                  },
                }));
                return;
              }

              res.statusCode = upstream.statusCode;
              res.setHeader('content-type', String(upstream.headers['content-type'] || 'application/json; charset=utf-8'));
              res.end(upstream.body);
            } catch (error: any) {
              const cause = error?.cause;
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: {
                  message: `Local images proxy failed: ${error?.message || String(error)}`,
                  type: 'local_images_proxy_error',
                  targetUrl: lastTargetUrl || undefined,
                  proxy: env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy() || '(none)',
                  cause: cause ? {
                    message: cause.message,
                    code: cause.code,
                    errno: cause.errno,
                    syscall: cause.syscall,
                  } : undefined,
                },
              }));
            }
          });

          server.middlewares.use('/api/minimax-video-proxy', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            try {
              const rawBody = await readRequestBody(req);
              const { action, baseUrl, apiKey, taskId, payload } = JSON.parse(rawBody || '{}');
              if (!apiKey || !['create', 'query'].includes(action)) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing MiniMax API key or invalid action' } }));
                return;
              }

              const targetBase = new URL(baseUrl || 'https://api.minimaxi.com');
              if (targetBase.protocol !== 'https:' || targetBase.hostname !== 'api.minimaxi.com') {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'MiniMax proxy only allows https://api.minimaxi.com' } }));
                return;
              }

              const targetUrl = action === 'create'
                ? 'https://api.minimaxi.com/v2/video_generation'
                : `https://api.minimaxi.com/v2/video_generation/${encodeURIComponent(String(taskId || ''))}`;
              if (action === 'query' && !taskId) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing MiniMax taskId' } }));
                return;
              }

              const proxyServer = env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy();
              let upstream;
              if (action === 'create') {
                upstream = await forwardJsonRequest(targetUrl, apiKey, payload, proxyServer);
              } else {
                upstream = proxyServer
                  ? await forwardGetRequestWithCurl(targetUrl, apiKey, 'minimax', proxyServer)
                  : null;
                if (!upstream) {
                  const direct = await fetch(targetUrl, {
                    headers: { Authorization: `Bearer ${apiKey}` }
                  });
                  upstream = {
                    statusCode: direct.status,
                    headers: Object.fromEntries(direct.headers.entries()),
                    body: Buffer.from(await direct.arrayBuffer())
                  };
                }
              }

              res.statusCode = upstream.statusCode;
              res.setHeader('content-type', String(upstream.headers['content-type'] || 'application/json; charset=utf-8'));
              res.end(upstream.body);
            } catch (error: any) {
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: { message: `MiniMax proxy failed: ${error?.message || String(error)}` }
              }));
            }
          });

          server.middlewares.use('/api/model-list-proxy', async (req, res) => {
            let targetUrl = '';

            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
              return;
            }

            try {
              const rawBody = await readRequestBody(req);
              const { baseUrl, apiKey, providerType } = JSON.parse(rawBody || '{}');
              const type = providerType || 'openai';

              if (!apiKey) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: { message: 'Missing apiKey' } }));
                return;
              }

              targetUrl = normalizeModelListUrl(baseUrl || '', type);
              const openaiProxyServer = env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy();
              let upstream = openaiProxyServer
                ? await forwardGetRequestWithCurl(targetUrl, apiKey, type, openaiProxyServer)
                : null;

              if (!upstream) {
                const headers: Record<string, string> = type === 'gemini'
                  ? { 'x-goog-api-key': apiKey }
                  : { Authorization: `Bearer ${apiKey}` };
                const direct = await fetch(targetUrl, { method: 'GET', headers });
                upstream = {
                  statusCode: direct.status,
                  headers: Object.fromEntries(direct.headers.entries()),
                  body: Buffer.from(await direct.arrayBuffer()),
                };
              }

              const contentType = String(upstream.headers['content-type'] || 'application/json; charset=utf-8');
              const text = upstream.body.toString('utf8');
              if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
                res.statusCode = upstream.statusCode;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: `Model list request failed: HTTP ${upstream.statusCode}`,
                    type: 'model_list_error',
                    targetUrl,
                    contentType,
                    preview: text.slice(0, 800),
                  },
                }));
                return;
              }

              let data: any;
              try {
                data = JSON.parse(text);
              } catch (error: any) {
                res.statusCode = 502;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: {
                    message: `Model list response is not JSON: ${error?.message || String(error)}`,
                    type: 'model_list_parse_error',
                    targetUrl,
                    contentType,
                    preview: text.slice(0, 800),
                  },
                }));
                return;
              }

              const models = extractModelIds(data);
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ models, targetUrl }));
            } catch (error: any) {
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: {
                  message: `Local model list proxy failed: ${error?.message || String(error)}`,
                  type: 'local_model_list_proxy_error',
                  targetUrl: targetUrl || undefined,
                  proxy: env.VITE_OPENAI_PROXY_SERVER?.trim() || getWindowsHttpProxy() || '(none)',
                },
              }));
            }
          });
        },
      },
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(geminiApiKey),
      'process.env.GEMINI_API_KEY': JSON.stringify(geminiApiKey),
      'process.env.VITE_COMFLY_API_KEY': JSON.stringify(comflyApiKey),
      'process.env.COMFLY_API_KEY': JSON.stringify(comflyApiKey),
      'process.env.VITE_DEFAULT_IMAGE_API_KEY': JSON.stringify(comflyApiKey),
      'process.env.DEFAULT_IMAGE_API_KEY': JSON.stringify(comflyApiKey)
    },
    resolve: {
      alias: {
        '@': projectRoot,
        'react': path.join(projectRoot, 'node_modules', 'react'),
        'react-dom': path.join(projectRoot, 'node_modules', 'react-dom'),
      },
      dedupe: ['react', 'react-dom'],
    }
  };
});
