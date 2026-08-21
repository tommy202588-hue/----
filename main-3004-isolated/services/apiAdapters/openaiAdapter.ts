import { ApiAdapter, ImageGenerationRequest, ImageGenerationResponse, TextGenerationRequest } from './index';
import { OpenAIResponseParser } from './responseParser';

type ImagePayloadOptions = {
    responseFormat?: 'b64_json' | 'url' | 'omit';
    imageFieldName?: 'image' | 'image[]';
};

type ImageRequestAttempt = {
    label: string;
    url: string;
    options: ImagePayloadOptions;
};

const MAX_REFERENCE_IMAGE_EDGE = 1024;
const LARGE_REFERENCE_IMAGE_EDGE = 1536;

export class OpenAIAdapter implements ApiAdapter {
    async generateImage(
        request: ImageGenerationRequest,
        apiKey: string,
        baseUrl: string,
        endpointMode: string = 'chat',
        customEndpoint?: string,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<ImageGenerationResponse> {
        // Preserve the user's request mode. Direct-first can still fall back to
        // the local proxy when the browser cannot reach the provider.
        const effectiveRequestMode = requestMode;
        const imagesUrl = this.buildImageUrl(baseUrl, endpointMode, customEndpoint);
        const resolvedImagesUrl = this.resolveImageEndpoint(imagesUrl, request);

        if (this.shouldUseYunwuImagesEndpoint(baseUrl, request.model)) {
            console.log('[OpenAI] Yunwu gpt-image-2 uses the Images API; preserving model id and routing references to /images/edits.');
            return await this.generateWithImagesEndpoint(
                request,
                apiKey,
                imagesUrl,
                resolvedImagesUrl,
                'yunwu-gpt-image-2-images',
                effectiveRequestMode
            );
        }

        if (this.shouldForceChatCompletions(baseUrl) && await this.hasLargeReferenceImages(request.referenceImages)) {
            console.log('[OpenAI] Large reference image detected, routing forced-chat provider to Images API.');
            return await this.generateWithImagesEndpoint(request, apiKey, imagesUrl, resolvedImagesUrl, 'images-auto-large-reference', effectiveRequestMode);
        }

        if (this.shouldForceChatCompletions(baseUrl)) {
            const configuredUrl = this.buildChatCompletionsUrl(baseUrl);
            const chatRequest = {
                ...request,
                model: request.model?.trim() || 'gpt-image-2'
            };
            const payload = await this.buildChatPayload(chatRequest);
            const payloadSize = this.toOpenAIImageSize(this.normalizeAspectRatio(request.aspectRatio), request.resolution, request.model);
            const payloadQuality = this.toOpenAIQuality(request.quality, request.model) || this.toOpenAIQuality(request.resolution, request.model);

            console.log('[OpenAI] Image generation request:', {
                configuredUrl,
                url: configuredUrl,
                endpointAdjusted: imagesUrl !== configuredUrl,
                mode: 'chat-forced',
                reason: 'ai.comfly.org uses /v1/chat/completions',
                model: chatRequest.model,
                originalModel: request.model,
                aspectRatio: request.aspectRatio,
                resolution: request.resolution,
                payloadType: 'json',
                payloadSize,
                payloadQuality,
                referenceImageCount: request.referenceImages?.length || 0
            });
            console.log('[OpenAI] Full payload:', JSON.stringify(this.redactLargeImageUrls(payload), null, 2));

            try {
                return await this.generateWithChatResponse(configuredUrl, apiKey, payload, {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }, chatRequest, request, effectiveRequestMode);
            } catch (chatError: any) {
                console.warn('[OpenAI] ai.comfly.org chat image generation failed, trying Images API fallback.', chatError);

                try {
                    return await this.generateWithImagesEndpoint(request, apiKey, imagesUrl, resolvedImagesUrl, 'images-fallback-after-chat', effectiveRequestMode);
                } catch (fallbackError: any) {
                    throw new Error([
                        chatError?.message || String(chatError),
                        '',
                        '--- Images API fallback also failed ---',
                        fallbackError?.message || String(fallbackError)
                    ].join('\n'));
                }
            }
        }

        try {
            return await this.generateWithImagesEndpoint(request, apiKey, imagesUrl, resolvedImagesUrl, 'images', effectiveRequestMode);
        } catch (imagesError: any) {
            console.warn('[OpenAI] Images API generation failed.', imagesError);
            throw new Error([
                imagesError?.message || String(imagesError),
                '',
                '说明: 当前已按 OpenAI Images API 标准格式请求生图，未使用 chat/completions 兜底。',
                '如果这里报 400/500，表示当前供应商或模型不接受 /v1/images/generations 或 /v1/images/edits 的标准请求格式。'
            ].join('\n'));
        }

        const configuredUrl = this.buildChatCompletionsUrl(baseUrl);
        const chatRequest = {
            ...request,
            model: this.resolveChatImageModel(request.model, baseUrl)
        };
        const payload = await this.buildChatPayload(chatRequest);
        const payloadSize = this.toOpenAIImageSize(this.normalizeAspectRatio(request.aspectRatio), request.resolution, request.model);
        const payloadQuality = this.toOpenAIQuality(request.quality, request.model) || this.toOpenAIQuality(request.resolution, request.model);

        console.log('[OpenAI] Image generation request:', {
            configuredUrl,
            url: configuredUrl,
            endpointAdjusted: false,
            mode: 'chat',
            model: chatRequest.model,
            originalModel: request.model,
            aspectRatio: request.aspectRatio,
            resolution: request.resolution,
            payloadType: 'json',
            payloadSize,
            payloadQuality,
            referenceImageCount: request.referenceImages?.length || 0
        });
        console.log('[OpenAI] Full payload:', JSON.stringify(this.redactLargeImageUrls(payload), null, 2));

        const headers: HeadersInit = {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };

        try {
            return await this.generateWithChatResponse(configuredUrl, apiKey, payload, headers, chatRequest, request, effectiveRequestMode);
        } catch (error: any) {
            console.warn('[OpenAI] Chat image generation failed.', error);
            if (request.referenceImages?.length) {
                throw error;
            }

            try {
                const imageUrl = this.buildImageUrl(baseUrl, endpointMode, customEndpoint);
                return await this.generateWithImagesEndpoint(request, apiKey, imageUrl, imageUrl, 'images-fallback', effectiveRequestMode);
            } catch (fallbackError: any) {
                throw new Error([
                    error?.message || String(error),
                    '',
                    '--- Images API 兜底也失败 ---',
                    fallbackError?.message || String(fallbackError)
                ].join('\n'));
            }
        }

        const response = await this.fetchChatCompletions(configuredUrl, apiKey, payload, headers, effectiveRequestMode);

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error([
                `OpenAI API Error (${response.status}): ${errorBody}`,
                '',
                '--- OpenAI 请求诊断 ---',
                `配置 URL: ${configuredUrl}`,
                `URL: ${configuredUrl}`,
                `Endpoint 模式: chat/completions`,
                `Payload 类型: json`,
                `模型: ${request.model}`,
                `尺寸: ${payloadSize || '(未发送)'}`,
                `质量: ${payloadQuality || '(未发送)'}`,
                `参考图数量: ${request.referenceImages?.length || 0}`
            ].join('\n'));
        }

        const data = await this.readJsonResponse(response, 'OpenAI chat image response');
        const parsed = OpenAIResponseParser.parseImageResponse(data);

        if (parsed.images.length === 0) {
            console.error('[OpenAI] No images in response:', data);
            throw new Error('No image data in OpenAI response');
        }

        const processedImages = await this.processParsedImages(parsed.images);

        return {
            images: processedImages,
            primaryImage: processedImages[0]
        };
    }

    private async generateWithImagesEndpoint(
        request: ImageGenerationRequest,
        apiKey: string,
        configuredUrl: string,
        resolvedUrl: string,
        endpointMode: string,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<ImageGenerationResponse> {
        const attempts = this.buildImageRequestAttempts(configuredUrl, resolvedUrl, request);
        let lastError: Error | null = null;

        for (const attempt of attempts) {
            const payload = await this.buildImagesPayload(request, attempt.url, attempt.options);
            const isFormData = payload instanceof FormData;
            const payloadSize = isFormData ? payload.get('size') : payload.size;
            const payloadQuality = isFormData ? payload.get('quality') : payload.quality;
            const payloadResponseFormat = isFormData ? payload.get('response_format') : payload.response_format;

            console.log('[OpenAI] Image generation request:', {
                attempt: attempt.label,
                configuredUrl,
                url: attempt.url,
                endpointAdjusted: configuredUrl !== attempt.url,
                mode: endpointMode,
                model: request.model,
                aspectRatio: request.aspectRatio,
                resolution: request.resolution,
                payloadType: isFormData ? 'form-data' : 'json',
                payloadSize,
                payloadQuality,
                payloadResponseFormat: payloadResponseFormat || '(omit)',
                imageFieldName: attempt.options.imageFieldName || '(none)',
                referenceImageCount: request.referenceImages?.length || 0
            });
            if (!isFormData) {
                console.log('[OpenAI] Full payload:', JSON.stringify(payload, null, 2));
            }

            const headers: HeadersInit = {
                Authorization: `Bearer ${apiKey}`
            };
            if (!isFormData) {
                headers['Content-Type'] = 'application/json';
            }

            let response: Response;
            try {
                response = await this.fetchImagesEndpoint(attempt.url, apiKey, payload, headers, requestMode);
            } catch (error: any) {
                lastError = new Error([
                    `OpenAI API Network Error: ${error?.message || error}`,
                    '',
                    this.buildRequestDiagnostic(configuredUrl, attempt.url, endpointMode, isFormData, request, payloadSize, payloadQuality, payloadResponseFormat, attempt)
                ].join('\n'));
                continue;
            }

            let data: any = null;
            let responseText = '';

            if (!response.ok) {
                responseText = await response.text();
                lastError = new Error([
                    `OpenAI API Error (${response.status}): ${responseText}`,
                    '',
                    this.buildRequestDiagnostic(configuredUrl, attempt.url, endpointMode, isFormData, request, payloadSize, payloadQuality, payloadResponseFormat, attempt)
                ].join('\n'));
                continue;
            }

            try {
                data = await this.readJsonResponse(response, 'OpenAI image response');
            } catch (error: any) {
                lastError = new Error([
                    error?.message || 'OpenAI API Error: 响应不是合法 JSON。',
                    '',
                    this.buildRequestDiagnostic(configuredUrl, attempt.url, endpointMode, isFormData, request, payloadSize, payloadQuality, payloadResponseFormat, attempt)
                ].join('\n'));
                continue;
            }

            const parsed = OpenAIResponseParser.parseImageResponse(data);
            if (parsed.images.length === 0) {
                console.error('[OpenAI] No images in response:', data);
                lastError = new Error([
                    'No image data in OpenAI response',
                    '',
                    this.buildRequestDiagnostic(configuredUrl, attempt.url, endpointMode, isFormData, request, payloadSize, payloadQuality, payloadResponseFormat, attempt),
                    '',
                    `原始响应: ${JSON.stringify(data).slice(0, 1200)}`
                ].join('\n'));
                continue;
            }

            const processedImages = await this.processParsedImages(parsed.images);
            return {
                images: processedImages,
                primaryImage: processedImages[0]
            };
        }

        throw lastError || new Error('OpenAI API Error: all image request attempts failed');
    }

    private async fetchImagesEndpoint(
        url: string,
        apiKey: string,
        payload: any | FormData,
        directHeaders: HeadersInit,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<Response> {
        const isFormData = payload instanceof FormData;
        const canUseLocalProxy = typeof window !== 'undefined';

        if (!isFormData && requestMode === 'direct-first') {
            try {
                return await fetch(url, {
                    method: 'POST',
                    headers: directHeaders,
                    body: JSON.stringify(payload)
                });
            } catch (error) {
                console.warn('[OpenAI] Direct Images JSON request failed, trying local images proxy.', error);
            }
        }

        if (canUseLocalProxy) {
            const proxyPayload = isFormData
                ? await this.serializeFormDataForProxy(payload)
                : payload;

            return await this.fetchWithEmptyBodyRetry('/api/openai-images-proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetUrl: url,
                    apiKey,
                    payloadType: isFormData ? 'form-data' : 'json',
                    payload: proxyPayload
                })
            }, {
                url,
                proxy: true,
                model: isFormData ? String(payload.get('model') || '') : payload?.model,
                size: isFormData ? String(payload.get('size') || '') : payload?.size,
                quality: isFormData ? String(payload.get('quality') || '') : payload?.quality
            });
        }

        if (isFormData) {
            return await fetch(url, {
                method: 'POST',
                headers: directHeaders,
                body: payload
            });
        }

        return await fetch(url, {
            method: 'POST',
            headers: directHeaders,
            body: JSON.stringify(payload)
        });
    }

    private async serializeFormDataForProxy(formData: FormData): Promise<Array<any>> {
        const entries: Array<any> = [];
        for (const [name, value] of formData.entries()) {
            if (typeof value === 'string') {
                entries.push({ name, value, kind: 'field' });
                continue;
            }

            entries.push({
                name,
                kind: 'file',
                fileName: value instanceof File ? value.name : 'image.png',
                mimeType: value.type || 'image/png',
                dataUrl: await this.convertToImageUrl(value)
            });
        }
        return entries;
    }

    private async hasLargeReferenceImages(referenceImages?: (string | Blob)[]): Promise<boolean> {
        if (!referenceImages || referenceImages.length === 0) return false;

        for (const reference of referenceImages) {
            const dimensions = await this.getReferenceImageDimensions(reference);
            if (dimensions && Math.max(dimensions.width, dimensions.height) > LARGE_REFERENCE_IMAGE_EDGE) {
                return true;
            }
        }

        return false;
    }

    private async getReferenceImageDimensions(reference?: string | Blob): Promise<{ width: number; height: number } | null> {
        if (!reference) return null;

        if (typeof reference === 'string') {
            try {
                return await this.loadImageDimensions(reference);
            } catch {
                return null;
            }
        }

        const objectUrl = URL.createObjectURL(reference);
        try {
            return await this.loadImageDimensions(objectUrl);
        } catch {
            return null;
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    private loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve({
                width: image.naturalWidth || image.width,
                height: image.naturalHeight || image.height
            });
            image.onerror = reject;
            image.src = src;
        });
    }

    private async generateWithChatResponse(
        configuredUrl: string,
        apiKey: string,
        payload: any,
        headers: HeadersInit,
        chatRequest: ImageGenerationRequest,
        originalRequest: ImageGenerationRequest,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<ImageGenerationResponse> {
        const response = await this.fetchChatCompletions(configuredUrl, apiKey, payload, headers, requestMode);

        if (!response.ok) {
            const errorBodyText = (await response.text()).trim();
            const errorBody = errorBodyText || JSON.stringify({
                error: {
                    message: `HTTP ${response.status} returned an empty response body.`,
                    type: 'empty_error_response',
                    requestMode,
                    targetUrl: configuredUrl,
                    model: chatRequest.model,
                    size: this.toOpenAIImageSize(originalRequest.aspectRatio, originalRequest.resolution, originalRequest.model),
                    quality: this.toOpenAIQuality(originalRequest.quality, originalRequest.model) || this.toOpenAIQuality(originalRequest.resolution, originalRequest.model)
                }
            }, null, 2);
            throw new Error([
                `OpenAI API Error (${response.status}): ${errorBody}`,
                '',
                '--- OpenAI 请求诊断 ---',
                `配置 URL: ${configuredUrl}`,
                `URL: ${configuredUrl}`,
                'Endpoint 模式: chat/completions',
                'Payload 类型: json',
                `模型: ${chatRequest.model}${chatRequest.model !== originalRequest.model ? ` (由 ${originalRequest.model} 映射)` : ''}`,
                `尺寸: ${this.toOpenAIImageSize(originalRequest.aspectRatio, originalRequest.resolution, originalRequest.model) || '(写入提示词)'}`,
                `质量: ${this.toOpenAIQuality(originalRequest.quality, originalRequest.model) || this.toOpenAIQuality(originalRequest.resolution, originalRequest.model) || '(写入提示词)'}`,
                `参考图数量: ${originalRequest.referenceImages?.length || 0}`
            ].join('\n'));
        }

        const data = await this.readJsonResponse(response, 'OpenAI chat image response');
        const parsed = OpenAIResponseParser.parseImageResponse(data);

        if (parsed.images.length === 0) {
            console.error('[OpenAI] No images in response:', data);
            throw new Error([
                'OpenAI chat image response: 接口有返回，但没有解析到图片 URL 或 base64。',
                `模型: ${chatRequest.model}`,
                `原始响应: ${JSON.stringify(data).slice(0, 1200)}`
            ].join('\n'));
        }

        const processedImages = await this.processParsedImages(parsed.images);
        return {
            images: processedImages,
            primaryImage: processedImages[0]
        };
    }

    private buildImageRequestAttempts(
        configuredUrl: string,
        resolvedUrl: string,
        request: ImageGenerationRequest
    ): ImageRequestAttempt[] {
        const hasReferenceImages = !!request.referenceImages?.length;

        if (!hasReferenceImages) {
            return [
                { label: 'text-to-image json openai fields', url: configuredUrl, options: {} }
            ];
        }

        const attempts: ImageRequestAttempt[] = [
            { label: 'image-to-image edits image[] openai fields', url: resolvedUrl, options: { imageFieldName: 'image[]' } },
            { label: 'image-to-image edits image openai fields', url: resolvedUrl, options: { imageFieldName: 'image' } }
        ];

        return attempts;
    }

    private buildRequestDiagnostic(
        configuredUrl: string,
        url: string,
        endpointMode: string,
        isFormData: boolean,
        request: ImageGenerationRequest,
        payloadSize: FormDataEntryValue | undefined,
        payloadQuality: FormDataEntryValue | undefined,
        payloadResponseFormat: FormDataEntryValue | undefined,
        attempt: ImageRequestAttempt
    ): string {
        return [
            '--- OpenAI 请求诊断 ---',
            `尝试格式: ${attempt.label}`,
            `配置 URL: ${configuredUrl}`,
            `URL: ${url}`,
            `Endpoint 模式: ${endpointMode}`,
            `Payload 类型: ${isFormData ? 'form-data' : 'json'}`,
            `图片字段: ${attempt.options.imageFieldName || '(无)'}`,
            `模型: ${request.model}`,
            `尺寸: ${payloadSize || '(未发送)'}`,
            `质量: ${payloadQuality || '(未发送)'}`,
            `返回格式: ${payloadResponseFormat || '(未发送)'}`,
            `参考图数量: ${request.referenceImages?.length || 0}`
        ].join('\n');
    }

    private async processParsedImages(images: string[]): Promise<string[]> {
        const processedImages: string[] = [];
        for (const img of images) {
            if (img.startsWith('http://') || img.startsWith('https://')) {
                try {
                    processedImages.push(img);
                } catch (error) {
                    console.error('[OpenAI] Failed to download image:', img, error);
                    throw new Error(`图片已生成，但下载到浏览器失败：${img}\n${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                processedImages.push(img);
            }
        }
        return processedImages;
    }

    private toLocalDownloadProxyUrl(url: string): string {
        if (typeof window === 'undefined') return url;
        return `/api/openai-download-proxy?url=${encodeURIComponent(url)}`;
    }

    async generateText(
        request: TextGenerationRequest,
        apiKey: string,
        baseUrl: string,
        endpointMode: string = 'chat',
        customEndpoint?: string,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<string> {
        const url = this.buildUrl(baseUrl, endpointMode, customEndpoint);
        const messages: any[] = [];

        if (request.systemPrompt) {
            messages.push({ role: 'system', content: request.systemPrompt });
        }

        if (request.referenceImages && request.referenceImages.length > 0) {
            const content: any[] = [{ type: 'text', text: request.prompt }];
            for (const img of request.referenceImages) {
                content.push({
                    type: 'image_url',
                    image_url: { url: await this.convertToImageUrl(img) }
                });
            }
            messages.push({ role: 'user', content });
        } else {
            messages.push({ role: 'user', content: request.prompt });
        }

        const payload: any = {
            model: request.model,
            messages
        };

        if (request.tsc !== undefined && baseUrl.includes('xwang.store')) {
            payload.tsc = request.tsc;
        }

        const response = await this.fetchChatCompletions(url, apiKey, payload, {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        }, requestMode);

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenAI API Error (${response.status}): ${errorBody}`);
        }

        const data = await this.readJsonResponse(response, 'OpenAI text response');
        return data.choices?.[0]?.message?.content || '';
    }

    private buildUrl(baseUrl: string, mode: string, customEndpoint?: string): string {
        let base = baseUrl.trim();
        if (base.endsWith('/')) base = base.slice(0, -1);

        if (mode === 'custom' && customEndpoint) {
            const custom = customEndpoint.trim();
            return custom.startsWith('/') ? `${base}${custom}` : `${base}/${custom}`;
        }

        return `${base}/v1/chat/completions`;
    }

    private buildChatCompletionsUrl(baseUrl: string): string {
        let base = baseUrl.trim();
        if (base.endsWith('/')) base = base.slice(0, -1);
        if (base.includes('/chat/completions')) return base;
        if (base.endsWith('/v1')) return `${base}/chat/completions`;
        return `${base}/v1/chat/completions`;
    }

    private shouldForceChatCompletions(baseUrl: string): boolean {
        return /(^|\/\/|[./])ai\.comfly\.org(\/|$)/i.test(baseUrl.trim());
    }

    private shouldUseYunwuImagesEndpoint(baseUrl: string, model?: string): boolean {
        return /(^|\/\/|[./])yunwu\.ai(\/|$)/i.test(baseUrl.trim())
            && model?.trim().toLowerCase() === 'gpt-image-2';
    }

    private async fetchChatCompletions(
        url: string,
        apiKey: string,
        payload: any,
        directHeaders: HeadersInit,
        requestMode: 'direct-first' | 'proxy-first' = 'direct-first'
    ): Promise<Response> {
        const shouldTryLocalProxy = typeof window !== 'undefined';
        const mustUseLocalProxy = this.shouldForceChatCompletions(url);
        let localProxyError = '';

        if (requestMode === 'direct-first') {
            try {
                return await this.fetchWithEmptyBodyRetry(url, {
                    method: 'POST',
                    headers: directHeaders,
                    body: JSON.stringify(payload)
                }, {
                    url,
                    proxy: false,
                    model: payload?.model,
                    size: payload?.size,
                    quality: payload?.quality
                });
            } catch (error: any) {
                localProxyError = `Direct first failed: ${error?.message || String(error)}`;
                console.warn('[OpenAI] Direct request failed, trying local proxy.', error);
            }
        }

        if (shouldTryLocalProxy) {
            try {
                const proxyResponse = await this.fetchWithEmptyBodyRetry('/api/openai-chat-proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetUrl: url, apiKey, payload })
                }, {
                    url,
                    proxy: true,
                    model: payload?.model,
                    size: payload?.size,
                    quality: payload?.quality
                });

                if (proxyResponse.status !== 404) {
                    if (proxyResponse.status === 502) {
                        try {
                            const errorData = await proxyResponse.clone().json();
                            if (errorData?.error?.type === 'local_proxy_error') {
                                localProxyError = JSON.stringify(errorData.error, null, 2);
                                if (mustUseLocalProxy) {
                                    return proxyResponse;
                                }
                                console.warn('[OpenAI] Local chat proxy failed, trying direct request.', errorData.error);
                            } else {
                                return proxyResponse;
                            }
                        } catch {
                            return proxyResponse;
                        }
                    } else {
                        return proxyResponse;
                    }
                }
            } catch (error: any) {
                localProxyError = error?.message || String(error);
                if (mustUseLocalProxy) {
                    throw new Error([
                        `OpenAI API Network Error: ${localProxyError}`,
                        '',
                        '--- Local Proxy Diagnostic ---',
                        `URL: ${url}`,
                        '当前供应商需要通过本地代理请求，不能回退到浏览器直连。',
                        '请确认当前页面是从 Vite 服务打开，例如 http://localhost:5178/ 或 http://192.168.0.229:5178/，不是便携 HTML/file 页面。',
                        '如果页面地址正确，请重启 5178 服务后再试。'
                    ].join('\n'));
                }
                console.warn('[OpenAI] Local chat proxy unavailable, falling back to direct request.', error);
            }
        }

        try {
            return await this.fetchWithEmptyBodyRetry(url, {
                method: 'POST',
                headers: directHeaders,
                body: JSON.stringify(payload)
            }, {
                url,
                proxy: false,
                model: payload?.model,
                size: payload?.size,
                quality: payload?.quality
            });
        } catch (error: any) {
            throw new Error([
                `OpenAI API Network Error: ${error?.message || String(error)}`,
                '',
                '--- 网络诊断 ---',
                `URL: ${url}`,
                `本地代理错误: ${localProxyError || '(未使用或无错误)'}`,
                '说明: 如果这里是 Failed to fetch / ECONNRESET，通常是当前网络无法连接该 API 域名，或目标服务拒绝该连接。'
            ].join('\n'));
        }
    }

    private async fetchWithEmptyBodyRetry(
        input: RequestInfo | URL,
        init: RequestInit,
        context: { url: string; proxy: boolean; model?: string; size?: string; quality?: string }
    ): Promise<Response> {
        let lastResponse: Response | null = null;
        const maxAttempts = 3;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const response = await fetch(input, init);
            lastResponse = response;

            if (response.status !== 200) {
                return response;
            }

            const text = await response.clone().text();
            if (text.trim()) {
                return response;
            }

            if (attempt < maxAttempts - 1) {
                await this.sleep(1200 + attempt * 1200);
            }
        }

        return new Response(JSON.stringify({
            error: {
                message: [
                    '接口返回 HTTP 200，但响应体为空，浏览器没有收到任何图片数据。',
                    '这通常表示当前模型或转发接口没有按 /v1/chat/completions 返回图片 URL/base64。',
                    '请确认 API 设置里的图片模型名称是该接口实际支持的生图模型，并且该接口支持 chat/completions 生图返回。'
                ].join('\n'),
                type: 'empty_upstream_response',
                targetUrl: context.url,
                throughLocalProxy: context.proxy,
                model: context.model || '(未发送)',
                size: context.size || '(未发送)',
                quality: context.quality || '(未发送)',
                upstreamStatus: lastResponse?.status || 200,
                upstreamContentType: lastResponse?.headers.get('content-type') || '(empty)'
            }
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    private async readJsonResponse(response: Response, label: string): Promise<any> {
        const text = await response.text();
        if (!text.trim()) {
            throw new Error([
                `${label}: 接口没有返回任何生成结果。`,
                '这通常表示上游接口返回了 HTTP 200 但 body 为空，画布没有可显示的图片数据。',
                `HTTP 状态: ${response.status}`,
                `Content-Type: ${response.headers.get('content-type') || '(empty)'}`,
                `响应长度: ${text.length}`,
                '',
                '请确认：',
                '1. 当前页面地址是 http://localhost:5174，并已 Ctrl+F5 强制刷新。',
                '2. API Key 有图像模型权限。',
                '3. 当前模型名是接口实际支持的图像模型。',
                '4. 如果接口继续返回空 body，需要更换模型/接口，或让接口服务端修复返回体。'
            ].join('\n'));
        }

        try {
            return JSON.parse(text);
        } catch (error: any) {
            throw new Error([
                `${label}: 接口返回内容不是合法 JSON。${error?.message || ''}`,
                `HTTP 状态: ${response.status}`,
                `Content-Type: ${response.headers.get('content-type') || '(empty)'}`,
                `响应长度: ${text.length}`,
                `响应片段: ${text.slice(0, 1200)}`
            ].join('\n'));
        }
    }

    private buildImageUrl(baseUrl: string, mode: string, customEndpoint?: string): string {
        let base = baseUrl.trim();
        if (base.endsWith('/')) base = base.slice(0, -1);

        if (mode === 'custom' && customEndpoint) {
            const custom = customEndpoint.trim();
            return custom.startsWith('/') ? `${base}${custom}` : `${base}/${custom}`;
        }

        return `${base}/v1/images/generations`;
    }

    private isImagesEndpoint(url: string): boolean {
        return /\/images\/(generations|edits|variations)(\?|$)/.test(url);
    }

    private resolveImageEndpoint(url: string, request: ImageGenerationRequest): string {
        if (request.referenceImages?.length && url.includes('/images/generations')) {
            return url.replace('/images/generations', '/images/edits');
        }

        return url;
    }

    private async buildImagesPayload(
        request: ImageGenerationRequest,
        url: string,
        options: ImagePayloadOptions = {}
    ): Promise<any | FormData> {
        const aspectRatio = this.normalizeAspectRatio(request.aspectRatio);
        const finalPrompt = aspectRatio
            ? `${request.prompt}, aspect ratio ${aspectRatio}`
            : request.prompt;
        const size = this.toOpenAIImageSize(aspectRatio, request.resolution, request.model) || '1024x1024';
        const quality = this.toOpenAIQuality(request.quality, request.model)
            || this.toOpenAIQuality(request.resolution, request.model)
            || this.defaultQualityForModel(request.model);

        if (request.referenceImages?.length) {
            const form = new FormData();
            form.append('model', request.model);
            form.append('prompt', finalPrompt);
            form.append('n', '1');
            form.append('size', size);
            form.append('quality', quality);

            for (let index = 0; index < request.referenceImages.length; index += 1) {
                const refImage = request.referenceImages[index];
                const imageBlob = typeof refImage === 'string'
                    ? await this.convertUrlToBlob(refImage)
                    : refImage;
                const normalizedBlob = await this.resizeBlobToMaxEdge(imageBlob, MAX_REFERENCE_IMAGE_EDGE);
                form.append(options.imageFieldName || this.imageFormFieldName(url, request.model), normalizedBlob, `reference-${index + 1}.png`);
            }
            return form;
        }

        const payload: any = {
            model: request.model,
            prompt: finalPrompt,
            n: 1,
            size,
            quality
        };

        return payload;
    }

    private async buildChatPayload(request: ImageGenerationRequest): Promise<any> {
        const aspectRatio = this.normalizeAspectRatio(request.aspectRatio);
        const size = this.toOpenAIImageSize(aspectRatio, request.resolution, request.model);
        const quality = this.toOpenAIQuality(request.quality, request.model) || this.toOpenAIQuality(request.resolution, request.model);
        const finalPrompt = [
            request.prompt,
            aspectRatio ? `Aspect ratio: ${aspectRatio}.` : '',
            size ? `Image size: ${size}.` : '',
            quality ? `Quality: ${quality}.` : ''
        ].filter(Boolean).join('\n');
        let userContent: string | any[] = finalPrompt;

        if (request.referenceImages && request.referenceImages.length > 0) {
            const contentParts: any[] = [{ type: 'text', text: finalPrompt }];
            for (const img of request.referenceImages) {
                const dataUrl = await this.convertToImageUrl(img);
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
            }
            userContent = contentParts;
        }

        const payload: any = {
            model: request.model,
            messages: [{ role: 'user', content: userContent }],
            n: 1,
            stream: false
        };

        return payload;
    }

    private redactLargeImageUrls(payload: any): any {
        if (!payload || typeof payload !== 'object') return payload;
        return JSON.parse(JSON.stringify(payload, (_key, value) => {
            if (typeof value === 'string' && value.startsWith('data:image')) {
                return `${value.slice(0, 48)}...(${value.length} chars)`;
            }
            return value;
        }));
    }

    private toOpenAIImageSize(aspectRatio?: string, resolution?: string, model?: string): string | undefined {
        const rawResolution = resolution?.trim().toLowerCase();
        if (rawResolution && /^\d+x\d+$/.test(rawResolution)) {
            return this.normalizeExplicitImageSize(rawResolution, model);
        }

        const tier = rawResolution === '4k' ? '4k' : rawResolution === '2k' ? '2k' : '1k';
        const ratio = aspectRatio || '1:1';
        const sizes: Record<string, Record<string, string>> = {
            '1k': {
                '1:1': '1024x1024',
                '16:9': '1536x864',
                '9:16': '864x1536',
                '4:3': '1024x768',
                '3:4': '768x1024',
                '3:2': '1536x1024',
                '2:3': '1024x1536',
                '21:9': '1536x656'
            },
            '2k': {
                '1:1': '2048x2048',
                '16:9': '2048x1152',
                '9:16': '1152x2048',
                '4:3': '2048x1536',
                '3:4': '1536x2048',
                '3:2': '2048x1360',
                '2:3': '1360x2048',
                '21:9': '2048x880'
            },
            '4k': {
                '1:1': '4096x4096',
                '16:9': '3840x2160',
                '9:16': '2160x3840',
                '4:3': '4096x3072',
                '3:4': '3072x4096',
                '3:2': '4096x2730',
                '2:3': '2730x4096',
                '21:9': '4096x1756'
            }
        };

        const mapped = sizes[tier][ratio] || sizes[tier]['1:1'];
        return this.normalizeExplicitImageSize(mapped, model);
    }

    private normalizeAspectRatio(aspectRatio?: string): string | undefined {
        const normalized = aspectRatio?.trim().toLowerCase();
        if (!normalized || normalized === 'auto') return undefined;
        return aspectRatio;
    }

    private normalizeExplicitImageSize(size: string, model?: string): string {
        const normalizedModel = model?.trim().toLowerCase() || '';

        if (normalizedModel.includes('dall-e-2')) {
            const [width, height] = size.split('x').map(Number);
            const edge = Math.max(width || 0, height || 0);
            if (edge <= 256) return '256x256';
            if (edge <= 512) return '512x512';
            return '1024x1024';
        }

        if (normalizedModel.includes('dall-e-3')) {
            const [width, height] = size.split('x').map(Number);
            if (width > height) return '1792x1024';
            if (height > width) return '1024x1792';
            return '1024x1024';
        }

        if (this.isGptImageModel(model) && !normalizedModel.includes('gpt-image-2')) {
            const [width, height] = size.split('x').map(Number);
            if (width > height) return '1536x1024';
            if (height > width) return '1024x1536';
            return '1024x1024';
        }

        if (normalizedModel.includes('gpt-image-2')) {
            return this.clampImageSizeLongestEdge(size, 3040);
        }

        return size;
    }

    private clampImageSizeLongestEdge(size: string, maxEdge: number): string {
        const [width, height] = size.split('x').map(Number);
        if (!width || !height) return size;

        const longestEdge = Math.max(width, height);
        if (longestEdge <= maxEdge) return size;

        const scale = maxEdge / longestEdge;
        const normalizeSide = (value: number) => {
            const rounded = Math.round(value / 16) * 16;
            return Math.max(16, Math.min(maxEdge, rounded));
        };
        const nextWidth = normalizeSide(width * scale);
        const nextHeight = normalizeSide(height * scale);
        return `${nextWidth}x${nextHeight}`;
    }

    private toOpenAIQuality(value?: string, model?: string): string | undefined {
        const normalized = value?.trim().toLowerCase();
        if (!normalized) return undefined;

        if (this.isGptImageModel(model)) {
            if (normalized === 'hd') return 'high';
            if (normalized === 'standard') return 'medium';
            if (['low', 'medium', 'high', 'auto'].includes(normalized)) {
                return normalized;
            }
            return undefined;
        }

        if (['low', 'medium', 'high', 'auto', 'standard', 'hd'].includes(normalized)) {
            return normalized;
        }
        return undefined;
    }

    private defaultQualityForModel(model?: string): string {
        return this.isGptImageModel(model) ? 'high' : 'hd';
    }

    private isHighResolutionRequest(resolution?: string): boolean {
        const normalized = resolution?.trim().toLowerCase() || '';
        if (normalized === '2k' || normalized === '4k') return true;
        const explicitSize = normalized.match(/^(\d+)x(\d+)$/);
        if (!explicitSize) return false;
        return Math.max(Number(explicitSize[1]) || 0, Number(explicitSize[2]) || 0) > 1536;
    }

    private resolveChatImageModel(model?: string, baseUrl?: string): string {
        const normalized = model?.trim() || '';
        if (normalized.toLowerCase() === 'gpt-image-2-all' || /^gpt-image-2-(?:1|2|4)k-\d+x\d+$/i.test(normalized)) {
            return 'gpt-image-2';
        }
        return normalized || 'gpt-image-2';
    }

    private isGptImageModel(model?: string): boolean {
        const normalized = model?.trim().toLowerCase() || '';
        return normalized.startsWith('gpt-image-') || normalized.startsWith('chatgpt-image-');
    }

    private imageFormFieldName(url: string, model?: string): string {
        if (url.includes('/images/edits') && this.isGptImageModel(model)) {
            return 'image[]';
        }
        return 'image';
    }

    private async downloadAndConvertToDataUrl(url: string): Promise<string> {
        const shouldUseLocalProxy = typeof window !== 'undefined'
            && ['localhost', '127.0.0.1'].includes(window.location.hostname);
        let response: Response | null = null;
        let details = '';

        for (let attempt = 0; attempt < 6; attempt += 1) {
            const separator = url.includes('?') ? '&' : '?';
            const cacheBustedUrl = attempt === 0 ? url : `${url}${separator}_tapnow_retry=${Date.now()}_${attempt}`;
            const downloadUrl = shouldUseLocalProxy
                ? `/api/openai-download-proxy?url=${encodeURIComponent(cacheBustedUrl)}&attempt=${attempt}`
                : cacheBustedUrl;

            response = await fetch(downloadUrl, { cache: 'no-store' });
            if (response.ok) break;

            try {
                details = await response.clone().text();
            } catch { }

            if (![404, 425, 429, 500, 502, 503, 504].includes(response.status)) {
                break;
            }

            await this.sleep(1200 + attempt * 900);
        }

        if (!response || !response.ok) {
            throw new Error(`Failed to download after retry: ${response?.status || 'no response'}${details ? ` ${details.slice(0, 500)}` : ''}`);
        }

        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(
            new Uint8Array(arrayBuffer).reduce(
                (data, byte) => data + String.fromCharCode(byte),
                ''
            )
        );

        const mimeType = blob.type || 'image/png';
        return `data:${mimeType};base64,${base64}`;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    private async convertToImageUrl(img: string | Blob): Promise<string> {
        const blob = await this.toReferenceBlob(img);
        const resized = await this.resizeBlobToMaxEdge(blob, MAX_REFERENCE_IMAGE_EDGE);
        return await this.blobToDataUrl(resized);
    }

    private async convertUrlToBlob(img: string): Promise<Blob> {
        const blob = await this.toReferenceBlob(img);
        return await this.resizeBlobToMaxEdge(blob, MAX_REFERENCE_IMAGE_EDGE);
    }

    private async toReferenceBlob(img: string | Blob): Promise<Blob> {
        if (img instanceof Blob) return img;

        if (img.startsWith('data:')) {
            const response = await fetch(img);
            if (!response.ok) {
                throw new Error(`Failed to load reference image: ${response.status}`);
            }
            return response.blob();
        }

        const response = await fetch(img);
        if (!response.ok) {
            throw new Error(`Failed to load reference image: ${response.status}`);
        }
        return response.blob();
    }

    private async resizeBlobToMaxEdge(blob: Blob, maxEdge: number): Promise<Blob> {
        try {
            const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
            const longestEdge = Math.max(bitmap.width, bitmap.height);
            if (longestEdge <= maxEdge) {
                bitmap.close?.();
                return blob;
            }

            const scale = maxEdge / longestEdge;
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                bitmap.close?.();
                return blob;
            }

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close?.();

            return await new Promise<Blob>((resolve) => {
                canvas.toBlob((nextBlob) => resolve(nextBlob || blob), 'image/png', 0.92);
            });
        } catch {
            return blob;
        }
    }

    private async blobToDataUrl(blob: Blob): Promise<string> {
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}
