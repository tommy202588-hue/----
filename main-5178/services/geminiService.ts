import { ApiProviderType, EndpointMode } from '../types/settings';

interface ApiConfig {
  apiKey?: string;
  baseUrl?: string;
  type?: ApiProviderType;
  endpointMode?: EndpointMode;
  customEndpoint?: string;
  requestMode?: 'direct-first' | 'proxy-first';
}

const YUNWU_GEMINI_IMAGE_MODEL = 'gemini-3-pro-image-preview';
const YUNWU_DEFAULT_BASE_URL = 'https://yunwu.ai';
const SUPPORTED_GEMINI_IMAGE_RATIOS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

type SupportedGeminiImageRatio = typeof SUPPORTED_GEMINI_IMAGE_RATIOS[number];

const isYunwuGeminiImageRequest = (model: string, apiConfig: ApiConfig) => {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedBaseUrl = (apiConfig.baseUrl || '').trim().toLowerCase();
  return normalizedModel === YUNWU_GEMINI_IMAGE_MODEL && !normalizedBaseUrl.includes('googleapis.com');
};

const normalizeYunwuBaseUrl = (baseUrl?: string) => {
  let normalized = (baseUrl || YUNWU_DEFAULT_BASE_URL).trim();
  if (!normalized) normalized = YUNWU_DEFAULT_BASE_URL;
  normalized = normalized.split('?')[0].replace(/\/+$/, '');
  normalized = normalized
    .replace(/\/v1beta\/models\/[^/]+:generateContent$/i, '')
    .replace(/\/v1beta\/models$/i, '')
    .replace(/\/v1beta$/i, '');
  return normalized || YUNWU_DEFAULT_BASE_URL;
};

const normalizeYunwuImageSize = (resolution?: string) => {
  const normalized = (resolution || '').trim().toLowerCase();
  if (normalized === '1k' || normalized === '2k' || normalized === '4k') {
    return normalized.toUpperCase();
  }

  const explicitSize = normalized.match(/^(\d+)x(\d+)$/);
  if (explicitSize) {
    const longestEdge = Math.max(Number(explicitSize[1]), Number(explicitSize[2]));
    if (longestEdge <= 1536) return '1K';
    if (longestEdge <= 2048) return '2K';
    return '4K';
  }

  return '1K';
};

const nearestSupportedRatio = (width: number, height: number): SupportedGeminiImageRatio => {
  if (!width || !height) return '1:1';
  const sourceRatio = width / height;
  return SUPPORTED_GEMINI_IMAGE_RATIOS.reduce((best, ratio) => {
    const [rw, rh] = ratio.split(':').map(Number);
    const [bw, bh] = best.split(':').map(Number);
    const currentDistance = Math.abs(Math.log(sourceRatio / (rw / rh)));
    const bestDistance = Math.abs(Math.log(sourceRatio / (bw / bh)));
    return currentDistance < bestDistance ? ratio : best;
  }, '1:1' as SupportedGeminiImageRatio);
};

const loadImageDimensions = (src: string): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = reject;
    image.src = src;
  });
};

const getReferenceImageDimensions = async (reference?: string | Blob): Promise<{ width: number; height: number } | null> => {
  if (!reference) return null;

  if (typeof reference === 'string') {
    try {
      return await loadImageDimensions(reference);
    } catch {
      return null;
    }
  }

  const objectUrl = URL.createObjectURL(reference);
  try {
    return await loadImageDimensions(objectUrl);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const normalizeYunwuAspectRatio = async (aspectRatio?: string, referenceImages: (string | Blob)[] = []) => {
  const normalized = (aspectRatio || '').trim().toLowerCase();
  if ((SUPPORTED_GEMINI_IMAGE_RATIOS as readonly string[]).includes(normalized)) {
    return normalized as SupportedGeminiImageRatio;
  }

  if (normalized === 'auto') {
    const dimensions = await getReferenceImageDimensions(referenceImages[0]);
    if (dimensions) {
      return nearestSupportedRatio(dimensions.width, dimensions.height);
    }
  }

  return '1:1';
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const blobToBase64Data = async (blob: Blob) => ({
  mimeType: blob.type || 'image/png',
  data: arrayBufferToBase64(await blob.arrayBuffer())
});

const referenceToInlineData = async (reference: string | Blob) => {
  if (typeof reference === 'string') {
    const dataUrlMatch = reference.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUrlMatch) {
      return {
        mimeType: dataUrlMatch[1] || 'image/png',
        data: dataUrlMatch[2].replace(/\s/g, '')
      };
    }

    if (/^(blob:|https?:\/\/)/i.test(reference)) {
      const response = await fetch(reference);
      if (!response.ok) {
        throw new Error(`Failed to load reference image: ${response.status}`);
      }
      return blobToBase64Data(await response.blob());
    }

    return null;
  }

  return blobToBase64Data(reference);
};

const redactYunwuPayload = (payload: any) => JSON.parse(JSON.stringify(payload, (_key, value) => {
  if (typeof value === 'string' && value.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return `${value.slice(0, 32)}...(${value.length} chars)`;
  }
  return value;
}));

const buildYunwuDiagnostic = (
  url: string,
  model: string,
  aspectRatio: string,
  imageSize: string,
  referenceImageCount: number,
  status?: number,
  responsePreview?: string
) => {
  const safeUrl = url.replace(/([?&]key=)[^&]+/i, '$1***');
  return [
    '--- Yunwu Gemini 请求诊断 ---',
    `URL: ${safeUrl}`,
    `模型: ${model}`,
    `比例: ${aspectRatio}`,
    `分辨率: ${imageSize}`,
    `参考图数量: ${referenceImageCount}`,
    status ? `HTTP 状态: ${status}` : '',
    responsePreview ? `响应片段: ${responsePreview.slice(0, 1200)}` : ''
  ].filter(Boolean).join('\n');
};

const extractYunwuGeminiImages = (data: any): string[] => {
  const images: string[] = [];
  const seen = new Set<string>();

  const addImage = (raw: unknown, mimeType = 'image/png') => {
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value || seen.has(value)) return;

    if (value.startsWith('data:image')) {
      images.push(value);
      seen.add(value);
      return;
    }

    if (/^https?:\/\//i.test(value)) {
      images.push(value);
      seen.add(value);
      return;
    }

    if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 200) {
      images.push(`data:${mimeType};base64,${value.replace(/\s/g, '')}`);
      seen.add(value);
    }
  };

  const visit = (current: any) => {
    if (!current) return;

    if (typeof current === 'string') {
      const markdownImageMatches = current.matchAll(/!\[[^\]]*]\(([^)]+)\)/g);
      for (const match of markdownImageMatches) addImage(match[1]);
      const urlMatches = current.matchAll(/https?:\/\/[^\s<>"')]+/g);
      for (const match of urlMatches) addImage(match[0]);
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (typeof current !== 'object') return;

    const inlineData = current.inline_data || current.inlineData;
    if (inlineData?.data) {
      addImage(inlineData.data, inlineData.mime_type || inlineData.mimeType || 'image/png');
    }

    addImage(current.url);
    addImage(current.file_uri);
    addImage(current.fileUri);
    addImage(current.b64_json);
    addImage(current.base64);
    addImage(current.image_base64);
    addImage(current.imageUrl);
    addImage(current.image_url?.url);

    Object.values(current).forEach(visit);
  };

  visit(data);
  return images;
};

const generateYunwuGeminiImage = async (
  prompt: string,
  model: string,
  aspectRatio: string,
  resolution: string,
  apiConfig: ApiConfig,
  referenceImages: (string | Blob)[]
): Promise<{ primaryImage: string; allImages: string[] }> => {
  const apiKey = apiConfig.apiKey || process.env.API_KEY || '';
  if (!apiKey) {
    throw new Error('API Key is missing. Please set it in Settings.');
  }

  const baseUrl = normalizeYunwuBaseUrl(apiConfig.baseUrl);
  const finalAspectRatio = await normalizeYunwuAspectRatio(aspectRatio, referenceImages);
  const imageSize = normalizeYunwuImageSize(resolution);
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts: any[] = [{ text: prompt }];
  for (const reference of referenceImages || []) {
    const inlineData = await referenceToInlineData(reference);
    if (!inlineData) continue;
    parts.push({
      inline_data: {
        mime_type: inlineData.mimeType,
        data: inlineData.data
      }
    });
  }

  const payload = {
    response_format: 'url',
    contents: [
      {
        role: 'user',
        parts
      }
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: finalAspectRatio,
        imageSize
      }
    }
  };

  console.log('[Yunwu Gemini] Image generation request:', {
    url: url.replace(/([?&]key=)[^&]+/i, '$1***'),
    model,
    aspectRatio: finalAspectRatio,
    imageSize,
    referenceImageCount: referenceImages?.length || 0
  });
  console.log('[Yunwu Gemini] Full payload:', JSON.stringify(redactYunwuPayload(payload), null, 2));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error: any) {
    throw new Error([
      `Yunwu Gemini API Network Error: ${error?.message || String(error)}`,
      '',
      buildYunwuDiagnostic(url, model, finalAspectRatio, imageSize, referenceImages?.length || 0)
    ].join('\n'));
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error([
      `Yunwu Gemini API Error (${response.status}): ${responseText || response.statusText}`,
      '',
      buildYunwuDiagnostic(url, model, finalAspectRatio, imageSize, referenceImages?.length || 0, response.status, responseText)
    ].join('\n'));
  }

  if (!responseText.trim()) {
    throw new Error([
      'Yunwu Gemini API Error: 接口没有返回任何生成结果。',
      '',
      buildYunwuDiagnostic(url, model, finalAspectRatio, imageSize, referenceImages?.length || 0, response.status, responseText)
    ].join('\n'));
  }

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (error: any) {
    throw new Error([
      `Yunwu Gemini API Error: 响应不是合法 JSON。${error?.message || ''}`,
      '',
      buildYunwuDiagnostic(url, model, finalAspectRatio, imageSize, referenceImages?.length || 0, response.status, responseText)
    ].join('\n'));
  }

  const images = extractYunwuGeminiImages(data);
  if (images.length === 0) {
    console.error('[Yunwu Gemini] No images in response:', data);
    throw new Error([
      'Yunwu Gemini API Error: 接口有返回，但没有解析到图片 URL 或 base64。',
      '',
      buildYunwuDiagnostic(url, model, finalAspectRatio, imageSize, referenceImages?.length || 0, response.status, responseText)
    ].join('\n'));
  }

  return { primaryImage: images[0], allImages: images };
};

export const generateImage = async (
  prompt: string,
  model: string = 'gemini-2.0-flash-exp', // Updated default to a likely image-capable model
  aspectRatio: string = '1:1',
  resolution: string = '1k',
  apiConfig: ApiConfig = {},
  referenceImages: (string | Blob)[] = [],
  quality?: string
): Promise<{ primaryImage: string; allImages: string[] }> => {
  try {
    const apiKey = apiConfig.apiKey || process.env.API_KEY || '';
    if (!apiKey) {
      throw new Error("API Key is missing. Please set it in Settings.");
    }

    if (isYunwuGeminiImageRequest(model, apiConfig)) {
      return await generateYunwuGeminiImage(
        prompt,
        model,
        aspectRatio,
        resolution,
        apiConfig,
        referenceImages
      );
    }

    // 如果是OpenAI类型，使用OpenAI适配器
    if (apiConfig.type === 'openai') {
      const { getAdapter } = await import('./apiAdapters/factory');
      const adapter = getAdapter('openai');
      const baseUrl = apiConfig.baseUrl || 'https://api.openai.com';

      const result = await adapter.generateImage(
        { prompt, model, aspectRatio, resolution, quality, referenceImages },
        apiKey,
        baseUrl,
        apiConfig.endpointMode,
        apiConfig.customEndpoint,
        apiConfig.requestMode
      );

      return { primaryImage: result.primaryImage, allImages: result.images };
    }

    // 默认使用Gemini逻辑

    // 1. Prepare Base URL
    // Default: https://generativelanguage.googleapis.com
    // We add /v1beta internally if not present, or rely on full path if user provided it?
    // Let's stick to the standard: defaults to standard googleapi, or uses user's proxy root.

    let baseUrl = 'https://generativelanguage.googleapis.com';
    let forceProxyHeaders = false;

    if (apiConfig.baseUrl && apiConfig.baseUrl.trim()) {
      baseUrl = apiConfig.baseUrl.trim();
      forceProxyHeaders = true;

      // Remove trailing slash
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      // Heuristic: If user entered "https://proxy.com", we assume they want standard path appending.
      // If they entered "https://proxy.com/v1", we respect that.
      // But the target endpoint is `/v1beta/models/...` or `/models/...` depending on what they provide.
      // Safest bet: Look for 'models'. If not present, append '/v1beta'.

      // Actually, to align with "baseurl + suffix", let's assume the user provides the HOST or PRE-PATH.
      // Standard path suffix: /v1beta/models/${model}:generateContent

      // Remove known suffixes if user accidentally added them to BaseURL
      baseUrl = baseUrl.replace(/\/v1beta$/, '');
    }

    const version = 'v1beta';
    const method = 'generateContent';

    // Construct final URL
    // Format: {BASE_URL}/{VERSION}/models/{MODEL}:{METHOD}
    const url = `${baseUrl}/${version}/models/${model}:${method}`;

    // console.log(`🚀 [Direct Fetch URL]: ${url}`);

    // 2. Prepare Headers
    const headers: HeadersInit = {
      'Content-Type': 'application/json'
    };

    // If using default Google Base URL, use x-goog-api-key header
    // Otherwise, use Authorization header for proxies
    if (baseUrl.includes('googleapis.com')) {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // 3. Prepare Payload (Generation Config)
    const parts: any[] = [{ text: prompt }];

    // Add Reference Images
    if (referenceImages && referenceImages.length > 0) {
      for (const img of referenceImages) {
        let mimeType = '';
        let data = '';

        if (typeof img === 'string') {
          if (img.startsWith('data:')) {
            const match = img.match(/^data:(.+);base64,(.+)$/);
            if (match) {
              mimeType = match[1];
              data = match[2];
            }
          } else if (img.startsWith('blob:') || img.startsWith('http')) {
            // Fetch the image and convert to base64
            try {
              const res = await fetch(img);
              const blob = await res.blob();
              mimeType = blob.type;
              const buffer = await blob.arrayBuffer();
              data = btoa(
                new Uint8Array(buffer)
                  .reduce((data, byte) => data + String.fromCharCode(byte), '')
              );
            } catch (e) {
              console.error(`Failed to fetch image from URL: ${img}`, e);
              continue;
            }
          }
        } else if (img instanceof Blob) {
          mimeType = img.type;
          const buffer = await img.arrayBuffer();
          data = btoa(
            new Uint8Array(buffer)
              .reduce((data, byte) => data + String.fromCharCode(byte), '')
          );
        }

        if (mimeType && data) {
          parts.push({
            inline_data: {
              mime_type: mimeType,
              data: data
            }
          });
        }
      }
    }

    const finalAspectRatio = await normalizeYunwuAspectRatio(aspectRatio, referenceImages);
    const imageSize = normalizeYunwuImageSize(resolution);

    const payload: any = {
      contents: [
        {
          parts: parts
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: finalAspectRatio,
          imageSize
        }
      }
    };

    // console.log("🚀 Payload:", JSON.stringify(payload, null, 2));

    // 4. Send Request
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (e) { }
      throw new Error(`Gemini API Error (${response.status}): ${errorBody || response.statusText}`);
    }

    const data = await response.json();

    // 5. Extract Image
    // Structure: candidates[0].content.parts[0].inline_data
    // Gemini通常只返回一张图片，但我们包装成与OpenAI一致的格式
    const allImages: string[] = [];

    if (data.candidates && data.candidates.length > 0) {
      for (const part of data.candidates[0].content.parts) {
        // REST API returns `inline_data` (snake_case) or `inlineData` (camelCase) depending on parser?
        // Fetch usually returns raw JSON, so snake_case normally, but Gemini V1beta might return camelCase if using protojson.
        // Let's handle both.
        const inlineData = part.inlineData || part.inline_data;

        if (inlineData && inlineData.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const imageData = `data:${mimeType};base64,${inlineData.data}`;
          allImages.push(imageData);
        }
      }

      if (allImages.length > 0) {
        return { primaryImage: allImages[0], allImages };
      }
    }

    throw new Error("No image data received from Gemini response.");

  } catch (error) {
    console.error("Gemini Image Generation Error:", error);
    throw error;
  }
};

export const generateText = async (
  prompt: string,
  model: string = 'gemini-3-pro-preview',
  apiConfig: ApiConfig = {},
  referenceImages: (string | Blob)[] = [],
  systemPrompt?: string,
  tsc?: number
): Promise<string> => {
  try {
    const apiKey = apiConfig.apiKey || '';
    if (!apiKey) throw new Error("Text API Key is missing. Please set it in Settings.");

    // 如果是OpenAI类型，使用OpenAI适配器
    if (apiConfig.type === 'openai') {
      const { getAdapter } = await import('./apiAdapters/factory');
      const adapter = getAdapter('openai');
      const baseUrl = apiConfig.baseUrl || 'https://api.openai.com';

      return await adapter.generateText(
        { prompt, model, referenceImages, systemPrompt, tsc },
        apiKey,
        baseUrl,
        apiConfig.endpointMode,
        apiConfig.customEndpoint,
        apiConfig.requestMode
      );
    }

    // 如果是Gemini类型，使用Gemini API格式
    if (apiConfig.type === 'gemini') {
      let baseUrl = apiConfig.baseUrl?.trim() || 'https://generativelanguage.googleapis.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      // 移除可能的版本后缀
      baseUrl = baseUrl.replace(/\/v1beta$/, '');

      const version = 'v1beta';
      const method = 'generateContent';
      const url = `${baseUrl}/${version}/models/${model}:${method}`;

      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      // Gemini使用x-goog-api-key header（如果是Google API）或Authorization header（如果是代理）
      if (baseUrl.includes('googleapis.com')) {
        headers['x-goog-api-key'] = apiKey;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // 准备内容parts
      const parts: any[] = [];

      // 添加system prompt（如果有）
      if (systemPrompt && systemPrompt.trim()) {
        parts.push({ text: `System: ${systemPrompt}\n\nUser: ${prompt}` });
      } else {
        parts.push({ text: prompt });
      }

      // 添加参考图片
      if (referenceImages && referenceImages.length > 0) {
        for (const img of referenceImages) {
          let mimeType = '';
          let data = '';

          if (typeof img === 'string') {
            if (img.startsWith('data:')) {
              const match = img.match(/^data:(.+);base64,(.+)$/);
              if (match) {
                mimeType = match[1];
                data = match[2];
              }
            } else if (img.startsWith('blob:') || img.startsWith('http')) {
              try {
                const res = await fetch(img);
                const blob = await res.blob();
                mimeType = blob.type;
                const buffer = await blob.arrayBuffer();
                data = btoa(
                  new Uint8Array(buffer)
                    .reduce((data, byte) => data + String.fromCharCode(byte), '')
                );
              } catch (e) {
                console.error(`Failed to fetch image from URL: ${img}`, e);
                continue;
              }
            }
          } else if (img instanceof Blob) {
            mimeType = img.type;
            const buffer = await img.arrayBuffer();
            data = btoa(
              new Uint8Array(buffer)
                .reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
          }

          if (mimeType && data) {
            parts.push({
              inline_data: {
                mime_type: mimeType,
                data: data
              }
            });
          }
        }
      }

      const payload: any = {
        contents: [{
          parts: parts
        }]
      };

      // Add tsc if provided and using xwang proxy
      if (tsc !== undefined && baseUrl.includes('xwang.store')) {
        payload.tsc = tsc;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorMsg = await response.text();
        throw new Error(`Gemini Text API Error (${response.status}): ${errorMsg}`);
      }

      const resData = await response.json();

      // 提取Gemini响应中的文本
      if (resData.candidates && resData.candidates.length > 0) {
        const candidate = resData.candidates[0];
        if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
          // 合并所有文本parts
          const textParts = candidate.content.parts
            .filter((part: any) => part.text)
            .map((part: any) => part.text);

          if (textParts.length > 0) {
            return textParts.join('');
          }
        }
      }

      throw new Error("No text data received from Gemini API.");
    }

    // 默认使用OpenAI兼容格式（用于其他未明确指定类型的情况）
    let baseUrl = apiConfig.baseUrl?.trim() || 'https://api.openai.com';
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

    // Support either base URL or full endpoint
    const url = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/v1/chat/completions`;

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    const messages: any[] = [];
    if (systemPrompt && systemPrompt.trim()) {
      messages.push({ role: "system", content: systemPrompt });
    }

    const contentParts: any[] = [{ type: 'text', text: prompt }];

    if (referenceImages && referenceImages.length > 0) {
      for (const img of referenceImages) {
        let dataUrl = '';
        if (typeof img === 'string') {
          dataUrl = img;
        } else if (img instanceof Blob) {
          const buffer = await img.arrayBuffer();
          const base64 = btoa(new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), ''));
          dataUrl = `data:${img.type};base64,${base64}`;
        }
        if (dataUrl) {
          contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
    }

    messages.push({ role: "user", content: contentParts });

    const payload: any = {
      model,
      messages: messages,
      temperature: 0.7
    };

    if (tsc !== undefined && baseUrl.includes('xwang.store')) {
      payload.tsc = tsc;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorMsg = await response.text();
      throw new Error(`Text API Error (${response.status}): ${errorMsg}`);
    }

    const resData = await response.json();
    if (resData.choices && resData.choices.length > 0) {
      return resData.choices[0].message.content;
    }

    throw new Error("No text data received from the Text API.");
  } catch (error) {
    console.error("Text Generation Error:", error);
    throw error;
  }
};

export const generateAudio = async (
  prompt: string,
  model: string = 'gpt-4o-mini-tts',
  apiConfig: ApiConfig = {},
  options: { voice?: string; format?: string; seconds?: string } = {}
): Promise<string> => {
  const apiKey = apiConfig.apiKey || '';
  if (!apiKey) throw new Error("Audio API Key is missing. Please set it in Settings.");

  let baseUrl = apiConfig.baseUrl?.trim() || 'https://api.openai.com';
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const customEndpoint = apiConfig.customEndpoint?.trim();
  const endpoint = customEndpoint
    ? (customEndpoint.startsWith('/') ? `${baseUrl}${customEndpoint}` : `${baseUrl}/${customEndpoint}`)
    : `${baseUrl}/v1/audio/speech`;

  const payload = {
    model,
    input: prompt,
    prompt,
    voice: options.voice || 'alloy',
    response_format: options.format || 'mp3',
    seconds: options.seconds
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch (e) { }
    throw new Error(`Audio API Error (${response.status}): ${errorBody || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const url = data.url || data.audio_url || data.output_url;
    if (url) return url;

    const base64 = data.audio || data.audio_base64 || data.b64_json || data.data?.[0]?.b64_json;
    if (base64) {
      const mime = data.mime_type || data.mimeType || `audio/${options.format || 'mpeg'}`;
      return base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`;
    }

    throw new Error('No audio data received from audio API response.');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};
