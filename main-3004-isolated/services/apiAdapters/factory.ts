import { ApiAdapter } from './index';
import { OpenAIAdapter } from './openaiAdapter';
import { ApiProviderType } from '../../types/settings';

class GeminiAdapter implements ApiAdapter {
    async generateImage(): Promise<any> {
        throw new Error('Gemini adapter not yet implemented. Use geminiService.ts directly for now.');
    }

    async generateText(): Promise<string> {
        throw new Error('Gemini adapter not yet implemented. Use geminiService.ts directly for now.');
    }
}

const adapters: Record<ApiProviderType, ApiAdapter> = {
    gemini: new GeminiAdapter(),
    openai: new OpenAIAdapter(),
    sora: new GeminiAdapter()
};

export function getAdapter(type: ApiProviderType): ApiAdapter {
    const adapter = adapters[type];
    if (!adapter) {
        throw new Error(`Unsupported API type: ${type}`);
    }
    return adapter;
}
