import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  HttpError,
  createSafeLookup,
  parseHostPatterns,
  validateTargetUrl,
} from './security.mjs';

const DEFAULT_UPSTREAM_HOSTS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.openlux.ai',
  'fourq.hk',
  'yunwu.ai',
  'api.minimaxi.com',
  'api.xwang.store',
];

const DEFAULT_DOWNLOAD_HOSTS = [
  ...DEFAULT_UPSTREAM_HOSTS,
  '*.openai.com',
  '*.oaistatic.com',
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidalleapiprodweu.blob.core.windows.net',
  'oaidalleapiprodwus.blob.core.windows.net',
  'storage.googleapis.com',
];

const numberFromEnv = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

export const loadConfig = (env = process.env) => ({
  host: env.API_HOST || '0.0.0.0',
  port: numberFromEnv(env.API_PORT, 5112, 1, 65535),
  upstreamHosts: parseHostPatterns(env.ALLOWED_UPSTREAM_HOSTS, DEFAULT_UPSTREAM_HOSTS),
  downloadHosts: parseHostPatterns(env.ALLOWED_DOWNLOAD_HOSTS, DEFAULT_DOWNLOAD_HOSTS),
  publicOrigins: String(env.PUBLIC_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean),
  uploadTarget: String(env.UPLOAD_PROXY_TARGET || '').trim(),
  requestTimeoutMs: numberFromEnv(env.REQUEST_TIMEOUT_MS, 300000, 5000, 900000),
  jsonBodyLimit: numberFromEnv(env.JSON_BODY_LIMIT_BYTES, 64 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  uploadBodyLimit: numberFromEnv(env.UPLOAD_BODY_LIMIT_BYTES, 128 * 1024 * 1024, 1024, 512 * 1024 * 1024),
  responseBodyLimit: numberFromEnv(env.RESPONSE_BODY_LIMIT_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  downloadResponseLimit: numberFromEnv(env.DOWNLOAD_RESPONSE_LIMIT_BYTES, 32 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  rateWindowMs: numberFromEnv(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
  rateMax: numberFromEnv(env.RATE_LIMIT_MAX, 120, 1, 10000),
  expensiveRateMax: numberFromEnv(env.EXPENSIVE_RATE_LIMIT_MAX, 30, 1, 10000),
  downloadRateMax: numberFromEnv(env.DOWNLOAD_RATE_LIMIT_MAX, 30, 1, 10000),
  maxConcurrency: numberFromEnv(env.MAX_CONCURRENCY, 8, 1, 128),
  maxConcurrencyPerIp: numberFromEnv(env.MAX_CONCURRENCY_PER_IP, 3, 1, 32),
  maxUploadConcurrency: numberFromEnv(env.MAX_UPLOAD_CONCURRENCY, 2, 1, 16),
});

const sendJson = (res, statusCode, payload, extraHeaders = {}) => {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
};

const setSecurityHeaders = res => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
};

const getClientIp = req => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
};

const requireSameOrigin = (req, config) => {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    throw new HttpError(403, 'Cross-site API requests are not allowed.', 'cross_site_request');
  }

  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return;
  if (config.publicOrigins.includes(origin)) return;

  let originHost = '';
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpError(403, 'Invalid request origin.', 'invalid_origin');
  }

  const requestHost = String(req.headers.host || '').toLowerCase();
  if (!requestHost || originHost !== requestHost) {
    throw new HttpError(403, 'Request origin does not match the public host.', 'origin_not_allowed');
  }
};

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limit) {
    req.resume();
    reject(new HttpError(413, 'Request body is too large.', 'request_too_large'));
    return;
  }

  const chunks = [];
  let received = 0;
  let settled = false;

  req.on('data', chunk => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) {
      settled = true;
      req.resume();
      reject(new HttpError(413, 'Request body is too large.', 'request_too_large'));
      return;
    }
    chunks.push(buffer);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks));
  });
  req.on('error', error => {
    if (settled) return;
    settled = true;
    reject(error);
  });
});

const readJson = async (req, limit) => {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.', 'invalid_json');
  }
};

const assertMethod = (req, method) => {
  if (req.method !== method) {
    throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
  }
};

const collectResponse = (upstream, limit) => new Promise((resolve, reject) => {
  const declaredLength = Number(upstream.headers['content-length'] || 0);
  if (declaredLength > limit) {
    upstream.destroy();
    reject(new HttpError(502, 'Upstream response is too large.', 'upstream_response_too_large'));
    return;
  }

  const chunks = [];
  let received = 0;
  upstream.on('data', chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) {
      upstream.destroy(new Error('Upstream response is too large.'));
      return;
    }
    chunks.push(buffer);
  });
  upstream.on('end', () => resolve(Buffer.concat(chunks)));
  upstream.on('error', error => {
    if (received > limit) {
      reject(new HttpError(502, 'Upstream response is too large.', 'upstream_response_too_large'));
    } else {
      reject(error);
    }
  });
});

const forwardRequest = async ({
  targetUrl,
  patterns,
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  responseLimit,
  redirects = 0,
}) => {
  const target = await validateTargetUrl(targetUrl, patterns);
  const lookup = createSafeLookup(patterns);

  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: '*/*',
        'user-agent': 'X-tapnow-NAS/1.0',
        ...headers,
        ...(body ? { 'content-length': body.length } : {}),
      },
      lookup,
      servername: target.hostname,
      timeout: timeoutMs,
    }, async upstream => {
      try {
        resolve({
          statusCode: upstream.statusCode || 502,
          headers: upstream.headers,
          body: await collectResponse(upstream, responseLimit),
        });
      } catch (error) {
        reject(error);
      }
    });

    request.on('timeout', () => request.destroy(new HttpError(504, 'Upstream request timed out.', 'upstream_timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });

  const location = response.headers.location;
  if (redirects > 0 && [301, 302, 303, 307, 308].includes(response.statusCode) && location) {
    const nextUrl = new URL(String(location), target).toString();
    return forwardRequest({
      targetUrl: nextUrl,
      patterns,
      method: response.statusCode === 303 ? 'GET' : method,
      headers,
      body: response.statusCode === 303 ? undefined : body,
      timeoutMs,
      responseLimit,
      redirects: redirects - 1,
    });
  }

  return response;
};

const forwardJson = async (targetUrl, apiKey, payload, authHeader, config) => {
  const body = Buffer.from(JSON.stringify(payload));
  const headerName = authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'authorization';
  const headers = {
    'content-type': 'application/json',
    [headerName]: headerName === 'x-goog-api-key' ? apiKey : `Bearer ${apiKey}`,
  };

  let upstream = await forwardRequest({
    targetUrl,
    patterns: config.upstreamHosts,
    method: 'POST',
    headers,
    body,
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });
  if (upstream.statusCode === 200 && upstream.body.length === 0) {
    upstream = await forwardRequest({
      targetUrl,
      patterns: config.upstreamHosts,
      method: 'POST',
      headers,
      body,
      timeoutMs: config.requestTimeoutMs,
      responseLimit: config.responseBodyLimit,
    });
  }
  return upstream;
};

const dataUrlToBuffer = (dataUrl, fallbackMime = 'application/octet-stream') => {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new HttpError(400, 'Invalid form-data file payload.', 'invalid_file_payload');
  const candidateMime = match[1] || fallbackMime;
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(candidateMime)
    ? candidateMime
    : 'application/octet-stream';
  const data = match[2]
    ? Buffer.from(match[3] || '', 'base64')
    : Buffer.from(decodeURIComponent(match[3] || ''), 'utf8');
  return { data, mimeType };
};

const quoteDisposition = value => String(value || '').replace(/["\r\n]/g, '_');

const serializeFormData = entries => {
  const boundary = `xtapnow-${randomBytes(18).toString('hex')}`;
  const chunks = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const name = quoteDisposition(entry.name);
    if (entry.kind === 'file') {
      const { data, mimeType } = dataUrlToBuffer(entry.dataUrl, entry.mimeType || 'image/png');
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${quoteDisposition(entry.fileName || 'image.png')}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ));
      chunks.push(data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(entry.value ?? '')}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
};

export const normalizeModelListUrl = (baseUrl, providerType) => {
  let base = String(baseUrl || '').trim();
  if (!base) {
    base = providerType === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : 'https://api.openai.com';
  }
  base = base.replace(/\/$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1beta\/models$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');
  return providerType === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
};

export const extractModelIds = data => {
  const ids = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().replace(/^models\//, '');
    if (normalized) ids.add(normalized);
  };
  if (Array.isArray(data)) data.forEach(item => add(typeof item === 'string' ? item : item?.id || item?.name));
  if (Array.isArray(data?.data)) data.data.forEach(item => add(item?.id || item?.name));
  if (Array.isArray(data?.models)) data.models.forEach(item => add(item?.id || item?.name));
  return [...ids];
};

const copyUpstreamResponse = (res, upstream, fallbackType = 'application/json; charset=utf-8') => {
  res.statusCode = upstream.statusCode;
  res.setHeader('content-type', String(upstream.headers['content-type'] || fallbackType));
  res.setHeader('cache-control', 'no-store');
  res.end(upstream.body);
};

const createLimiter = config => {
  const buckets = new Map();
  let checksSinceSweep = 0;
  let active = 0;
  let activeUploads = 0;
  const activeByIp = new Map();

  const checkRate = (ip, category = 'general') => {
    const now = Date.now();
    checksSinceSweep += 1;
    if (checksSinceSweep >= 500 || buckets.size > 10000) {
      checksSinceSweep = 0;
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      while (buckets.size > 10000) {
        buckets.delete(buckets.keys().next().value);
      }
    }
    const key = `${ip}:${category}`;
    const limit = category === 'expensive'
      ? config.expensiveRateMax
      : category === 'download'
        ? config.downloadRateMax
        : config.rateMax;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + config.rateWindowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      throw new HttpError(429, `Rate limit exceeded. Retry after ${retryAfter} seconds.`, 'rate_limited');
    }
  };

  const acquire = (ip, category = 'general') => {
    const perIp = activeByIp.get(ip) || 0;
    if (active >= config.maxConcurrency
      || perIp >= config.maxConcurrencyPerIp
      || (category === 'upload' && activeUploads >= config.maxUploadConcurrency)) {
      throw new HttpError(503, 'The API proxy is busy. Try again shortly.', 'concurrency_limit');
    }
    active += 1;
    if (category === 'upload') activeUploads += 1;
    activeByIp.set(ip, perIp + 1);
    return () => {
      active = Math.max(0, active - 1);
      if (category === 'upload') activeUploads = Math.max(0, activeUploads - 1);
      const next = Math.max(0, (activeByIp.get(ip) || 1) - 1);
      if (next === 0) activeByIp.delete(ip);
      else activeByIp.set(ip, next);
    };
  };

  return { checkRate, acquire };
};

const handleChatProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { targetUrl, apiKey, payload, authHeader } = await readJson(req, config.jsonBodyLimit);
  if (!targetUrl || !apiKey || payload == null) {
    throw new HttpError(400, 'Missing targetUrl, apiKey, or payload.', 'missing_proxy_fields');
  }
  const upstream = await forwardJson(targetUrl, String(apiKey), payload, authHeader, config);
  copyUpstreamResponse(res, upstream);
};

const handleImagesProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { targetUrl, apiKey, payloadType, payload } = await readJson(req, config.jsonBodyLimit);
  if (!targetUrl || !apiKey || payload == null) {
    throw new HttpError(400, 'Missing targetUrl, apiKey, or payload.', 'missing_proxy_fields');
  }

  if (payloadType === 'form-data') {
    const form = serializeFormData(payload);
    if (form.body.length > config.uploadBodyLimit) {
      throw new HttpError(413, 'Serialized image request is too large.', 'request_too_large');
    }
    const upstream = await forwardRequest({
      targetUrl,
      patterns: config.upstreamHosts,
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': form.contentType,
      },
      body: form.body,
      timeoutMs: config.requestTimeoutMs,
      responseLimit: config.responseBodyLimit,
    });
    copyUpstreamResponse(res, upstream);
    return;
  }

  const upstream = await forwardJson(targetUrl, String(apiKey), payload, 'authorization', config);
  copyUpstreamResponse(res, upstream);
};

const handleMiniMaxProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { action, baseUrl, apiKey, taskId, payload } = await readJson(req, config.jsonBodyLimit);
  if (!apiKey || !['create', 'query'].includes(action)) {
    throw new HttpError(400, 'Missing MiniMax API key or invalid action.', 'invalid_minimax_request');
  }
  if (action === 'create' && payload == null) {
    throw new HttpError(400, 'Missing MiniMax create payload.', 'invalid_minimax_request');
  }
  let base;
  try {
    base = new URL(baseUrl || 'https://api.minimaxi.com');
  } catch {
    throw new HttpError(400, 'Invalid MiniMax base URL.', 'invalid_minimax_request');
  }
  if (base.protocol !== 'https:' || base.hostname !== 'api.minimaxi.com') {
    throw new HttpError(403, 'MiniMax proxy only allows https://api.minimaxi.com.', 'target_not_allowed');
  }
  if (action === 'query' && !taskId) {
    throw new HttpError(400, 'Missing MiniMax taskId.', 'invalid_minimax_request');
  }

  const targetUrl = action === 'create'
    ? 'https://api.minimaxi.com/v2/video_generation'
    : `https://api.minimaxi.com/v2/video_generation/${encodeURIComponent(String(taskId))}`;
  const upstream = action === 'create'
    ? await forwardJson(targetUrl, String(apiKey), payload, 'authorization', config)
    : await forwardRequest({
        targetUrl,
        patterns: config.upstreamHosts,
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.requestTimeoutMs,
        responseLimit: config.responseBodyLimit,
      });
  copyUpstreamResponse(res, upstream);
};

const handleModelList = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { baseUrl, apiKey, providerType = 'openai' } = await readJson(req, config.jsonBodyLimit);
  if (!apiKey) throw new HttpError(400, 'Missing apiKey.', 'missing_api_key');
  const targetUrl = normalizeModelListUrl(baseUrl, providerType);
  const upstream = await forwardRequest({
    targetUrl,
    patterns: config.upstreamHosts,
    method: 'GET',
    headers: providerType === 'gemini'
      ? { 'x-goog-api-key': String(apiKey) }
      : { authorization: `Bearer ${apiKey}` },
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });

  const contentType = String(upstream.headers['content-type'] || 'application/json');
  const text = upstream.body.toString('utf8');
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    throw new HttpError(upstream.statusCode, `Model list request failed: HTTP ${upstream.statusCode}.`, 'model_list_error');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `Model list response is not JSON (${contentType}).`, 'model_list_parse_error');
  }
  sendJson(res, 200, { models: extractModelIds(data), targetUrl });
};

const handleDownload = async (req, res, config, requestUrl) => {
  assertMethod(req, 'GET');
  const targetUrl = requestUrl.searchParams.get('url');
  if (!targetUrl) throw new HttpError(400, 'Missing url.', 'missing_download_url');
  const upstream = await forwardRequest({
    targetUrl,
    patterns: config.downloadHosts,
    method: 'GET',
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.downloadResponseLimit,
    redirects: 3,
  });
  const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !contentType.toLowerCase().startsWith('image/')) {
    throw new HttpError(upstream.statusCode >= 400 ? upstream.statusCode : 502, 'Image download failed.', 'image_download_error');
  }
  res.statusCode = upstream.statusCode;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'private, max-age=300');
  res.end(upstream.body);
};

const handleUpload = async (req, res, config) => {
  assertMethod(req, 'POST');
  if (!config.uploadTarget) {
    throw new HttpError(503, 'UPLOAD_PROXY_TARGET is not configured.', 'upload_proxy_disabled');
  }
  const body = await readBody(req, config.uploadBodyLimit);
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
  const upstream = await forwardRequest({
    targetUrl: config.uploadTarget,
    patterns: config.upstreamHosts,
    method: 'POST',
    headers,
    body,
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });
  copyUpstreamResponse(res, upstream);
};

const routeRequest = async (req, res, config, limiter) => {
  const requestUrl = new URL(req.url || '/', 'http://api.internal');
  if (requestUrl.pathname === '/healthz') {
    assertMethod(req, 'GET');
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (!requestUrl.pathname.startsWith('/api/')) {
    throw new HttpError(404, 'Not found.', 'not_found');
  }
  if (['/api/choose-save-directory', '/api/save-generated-image'].includes(requestUrl.pathname)) {
    throw new HttpError(501, 'Desktop file-system APIs are disabled in the public deployment.', 'desktop_api_disabled');
  }

  requireSameOrigin(req, config);
  const ip = getClientIp(req);
  const isDownload = requestUrl.pathname === '/api/openai-download-proxy';
  const isUpload = requestUrl.pathname === '/api/upload';
  limiter.checkRate(ip, 'general');
  limiter.checkRate(ip, isDownload ? 'download' : 'expensive');
  const release = limiter.acquire(ip, isUpload ? 'upload' : 'general');
  try {
    switch (requestUrl.pathname) {
      case '/api/openai-chat-proxy':
      case '/api/gemini-image-proxy':
        await handleChatProxy(req, res, config);
        break;
      case '/api/openai-images-proxy':
        await handleImagesProxy(req, res, config);
        break;
      case '/api/minimax-video-proxy':
        await handleMiniMaxProxy(req, res, config);
        break;
      case '/api/model-list-proxy':
        await handleModelList(req, res, config);
        break;
      case '/api/openai-download-proxy':
        await handleDownload(req, res, config, requestUrl);
        break;
      case '/api/upload':
        await handleUpload(req, res, config);
        break;
      default:
        throw new HttpError(404, 'Not found.', 'not_found');
    }
  } finally {
    release();
  }
};

export const createApiServer = (overrides = {}) => {
  const config = { ...loadConfig(), ...overrides };
  const limiter = createLimiter(config);
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const pathname = new URL(req.url || '/', 'http://api.internal').pathname;
    setSecurityHeaders(res);
    res.setHeader('x-request-id', requestId);

    try {
      await routeRequest(req, res, config, limiter);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 502;
      const type = error instanceof HttpError ? error.type : 'proxy_error';
      const message = error instanceof Error ? error.message : 'Unexpected proxy error.';
      sendJson(res, statusCode, { error: { message, type, requestId } });
    } finally {
      const statusCode = res.statusCode || 500;
      console.info(JSON.stringify({
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        requestId,
        method: req.method,
        path: pathname,
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp: getClientIp(req),
      }));
    }
  });
};

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const config = loadConfig();
  const server = createApiServer(config);
  server.listen(config.port, config.host, () => {
    console.info(JSON.stringify({
      level: 'info',
      message: 'X-tapnow API proxy listening',
      host: config.host,
      port: config.port,
      upstreamHostCount: config.upstreamHosts.length,
      downloadHostCount: config.downloadHosts.length,
      uploadEnabled: Boolean(config.uploadTarget),
    }));
  });
}
