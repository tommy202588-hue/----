import { get, set } from 'idb-keyval';
import { NodeData, Connection, GroupData } from '../types';

const STORAGE_KEY = 'X-tapnow_project_data';

export interface ProjectData {
    nodes: NodeData[];
    connections: Connection[];
    groups?: GroupData[];
    viewport?: { x: number; y: number; k: number };
    version: number;
    settings?: any; // AppSettings
    characters?: any[]; // Character list
    extraConfig?: Record<string, string>; // Legacy keys like sora_api_base_url
}

const CURRENT_VERSION = 1;

// --- IndexedDB (Auto-save) ---

export const saveProjectToIndexedDB = async (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = []
) => {
    const data: ProjectData = {
        nodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION
    };
    await set(STORAGE_KEY, data);
};

export const loadProjectFromIndexedDB = async (): Promise<ProjectData | null> => {
    const data = await get(STORAGE_KEY) as ProjectData | null;
    if (data && data.nodes) {
        data.nodes = data.nodes.map(node => {
            if (node.blob) {
                if (typeof node.content === 'string' && node.content.startsWith('data:image')) {
                    return node;
                }
                return {
                    ...node,
                    content: URL.createObjectURL(node.blob)
                };
            }
            return node;
        });
    }
    return data;
};

// --- File Export/Import ---

// Helper: Convert Blob to Base64
const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

// Helper: Convert Base64 to Blob
const base64ToBlob = (base64: string): Blob => {
    const parts = base64.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
};

const redactProviderApiKey = (provider: any) => {
    if (!provider || typeof provider !== 'object') return provider;
    if (!('apiKey' in provider)) return provider;
    return { ...provider, apiKey: '' };
};

const sanitizeSettingsForExport = (rawSettings: any) => {
    if (!rawSettings || typeof rawSettings !== 'object') return rawSettings;

    return {
        ...rawSettings,
        imageProviders: Array.isArray(rawSettings.imageProviders)
            ? rawSettings.imageProviders.map(redactProviderApiKey)
            : rawSettings.imageProviders,
        videoProviders: Array.isArray(rawSettings.videoProviders)
            ? rawSettings.videoProviders.map(redactProviderApiKey)
            : rawSettings.videoProviders,
        textProviders: Array.isArray(rawSettings.textProviders)
            ? rawSettings.textProviders.map(redactProviderApiKey)
            : rawSettings.textProviders,
        audioProviders: Array.isArray(rawSettings.audioProviders)
            ? rawSettings.audioProviders.map(redactProviderApiKey)
            : rawSettings.audioProviders,
    };
};

export const exportProjectToJson = async (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = [],
    includeSensitiveData: boolean = false
) => {
    // Convert blobs to base64 for serialization
    const serializableNodes = await Promise.all(
        nodes.map(async (node) => {
            const serialized: any = { ...node };

            if (node.blob) {
                serialized.blobData = await blobToBase64(node.blob);
                delete serialized.blob;
            }

            if (node.allBlobs && node.allBlobs.length > 0) {
                serialized.allBlobsData = await Promise.all(
                    node.allBlobs.map(blob => blobToBase64(blob))
                );
                delete serialized.allBlobs;
            }

            return serialized;
        })
    );

    // Gather extra data for backup
    let settings;
    try {
        const s = localStorage.getItem('X-tapnow_app_settings');
        if (s) {
            const parsedSettings = JSON.parse(s);
            settings = includeSensitiveData ? parsedSettings : sanitizeSettingsForExport(parsedSettings);
        }
    } catch (e) {
        console.error('Failed to read settings for export', e);
    }

    let characters;
    try {
        const c = localStorage.getItem('sora_characters');
        if (c) {
            characters = JSON.parse(c);
        }
    } catch (e) {
        console.error('Failed to read characters for export', e);
    }

    const extraConfig: Record<string, string> = {};
    const baseUrl = localStorage.getItem('sora_api_base_url');
    if (baseUrl) extraConfig['sora_api_base_url'] = baseUrl;

    if (includeSensitiveData) {
        const token = localStorage.getItem('sora_character_token');
        if (token) extraConfig['sora_character_token'] = token;
    }

    const data: ProjectData = {
        nodes: serializableNodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION,
        settings,
        characters,
        extraConfig
    };

    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `X-tapnow-project-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// --- Workflow Library (Internal) ---

export interface WorkflowEntry {
    id: string;
    name: string;
    timestamp: number;
    nodes: NodeData[];
    connections: Connection[];
    groups?: GroupData[];
    viewport?: { x: number; y: number; k: number };
}

const WORKFLOWS_KEY = 'X-tapnow_workflows';

export const saveWorkflowToLibrary = async (
    name: string,
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number }
) => {
    const workflows = (await get(WORKFLOWS_KEY)) as WorkflowEntry[] || [];

    const cleanNodes = nodes.map(n => ({
        ...n,
        status: 'idle' as const,
    }));

    const newEntry: WorkflowEntry = {
        id: crypto.randomUUID(),
        name,
        timestamp: Date.now(),
        nodes: cleanNodes,
        connections,
        viewport
    };

    workflows.push(newEntry);
    await set(WORKFLOWS_KEY, workflows);
    return newEntry;
};

export const getWorkflowLibrary = async (): Promise<WorkflowEntry[]> => {
    return (await get(WORKFLOWS_KEY)) || [];
};

export const deleteWorkflowFromLibrary = async (id: string) => {
    const workflows = (await get(WORKFLOWS_KEY)) as WorkflowEntry[] || [];
    const newWorkflows = workflows.filter(w => w.id !== id);
    await set(WORKFLOWS_KEY, newWorkflows);
    return newWorkflows;
};

export const exportWorkflowToJson = (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = []
) => {
    // Create a lightweight version (stripping images)
    const lightweightNodes = nodes.map(node => ({
        ...node,
        content: '', // Clear generated image content
        status: 'idle' as const // Reset status
    }));

    const data: ProjectData = {
        nodes: lightweightNodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION
    };

    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `X-tapnow-workflow-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

export const importProjectFromJson = (file: File): Promise<ProjectData> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const result = e.target?.result as string;
                const data = JSON.parse(result) as ProjectData;

                // Basic validation
                if (!Array.isArray(data.nodes) || !Array.isArray(data.connections)) {
                    reject(new Error("Invalid project file format"));
                    return;
                }

                // Convert base64 back to blobs
                data.nodes = data.nodes.map((node: any) => {
                    const restored: any = { ...node };

                    // Restore main blob from base64
                    if (node.blobData) {
                        restored.blob = base64ToBlob(node.blobData);
                        restored.content = URL.createObjectURL(restored.blob);
                        delete restored.blobData;
                    }

                    // Restore all blobs from base64
                    if (node.allBlobsData && Array.isArray(node.allBlobsData)) {
                        restored.allBlobs = node.allBlobsData.map((base64: string) =>
                            base64ToBlob(base64)
                        );
                        restored.allImages = restored.allBlobs.map((blob: Blob) =>
                            URL.createObjectURL(blob)
                        );
                        delete restored.allBlobsData;
                    }

                    return restored;
                });

                resolve(data);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
    });
};

// --- Settings Management ---

import { AppSettings, ApiProvider } from '../types/settings';

const SETTINGS_KEY = 'X-tapnow_app_settings';
const XWANG_VIDEO_PROVIDER_SEEDED_KEY = 'X-tapnow_xwang_video_provider_seeded';
const XWANG_AUDIO_PROVIDER_SEEDED_KEY = 'X-tapnow_xwang_audio_provider_seeded';
const LEGACY_CREDENTIAL_CLEANUP_KEY = 'X-tapnow_legacy_credential_cleanup_2026_07_21_v1';
const LEGACY_CREDENTIAL_KEYS = [
    'gemini_api_key',
    'sora_api_key',
    'text_api_key',
    'audio_api_key',
    'sora_character_token'
];

declare const process: {
    env?: Record<string, string | undefined>;
};

const getBundledComflyApiKey = () =>
    (typeof process !== 'undefined' && process.env
        ? (
            process.env.VITE_COMFLY_API_KEY ||
            process.env.COMFLY_API_KEY ||
            process.env.VITE_DEFAULT_IMAGE_API_KEY ||
            process.env.DEFAULT_IMAGE_API_KEY ||
            ''
        )
        : ''
    ).trim();

const COMFLY_IMAGE_PROVIDER_ID = 'default-comfly-image';
const COMFLY_IMAGE_MODELS = [
    { id: 'gpt-image-2', displayName: 'gpt-image-2' },
    { id: 'gemini-3.1-flash-image-preview-2k', displayName: 'nano banana 2-2k' },
    { id: 'gemini-3.1-flash-image-preview-4k', displayName: 'nano banana 2-4k' }
];

const createDefaultComflyImageProvider = (apiKey = ''): ApiProvider => ({
    id: COMFLY_IMAGE_PROVIDER_ID,
    name: 'comfly',
    apiKey,
    baseUrl: 'https://ai.comfly.org',
    type: 'openai',
    endpointMode: 'chat',
    models: COMFLY_IMAGE_MODELS,
    isDefault: true
});

const ensureDefaultComflyImageProvider = (settings: AppSettings): AppSettings => {
    const bundledApiKey = getBundledComflyApiKey();
    const existingIndex = settings.imageProviders.findIndex(provider =>
        provider.id === COMFLY_IMAGE_PROVIDER_ID ||
        provider.name?.toLowerCase() === 'comfly' ||
        provider.baseUrl?.includes('ai.comfly.org')
    );

    if (existingIndex >= 0) {
        const providers = [...settings.imageProviders];
        const existing = providers[existingIndex];
        const modelMap = new Map(existing.models.map(model => [model.id, model]));
        COMFLY_IMAGE_MODELS.forEach(model => {
            if (!modelMap.has(model.id)) {
                modelMap.set(model.id, model);
            }
        });

        providers[existingIndex] = {
            ...existing,
            id: existing.id || COMFLY_IMAGE_PROVIDER_ID,
            name: existing.name || 'comfly',
            apiKey: existing.apiKey || bundledApiKey,
            baseUrl: existing.baseUrl || 'https://ai.comfly.org',
            type: 'openai',
            endpointMode: existing.endpointMode || 'chat',
            models: Array.from(modelMap.values()),
            isDefault: true
        };

        return {
            ...settings,
            imageProviders: providers.map((provider, index) => ({
                ...provider,
                isDefault: index === existingIndex
            })),
            defaultImageProvider: providers[existingIndex].id
        };
    }

    const provider = createDefaultComflyImageProvider(bundledApiKey);
    return {
        ...settings,
        imageProviders: [
            provider,
            ...settings.imageProviders.map(provider => ({ ...provider, isDefault: false }))
        ],
        defaultImageProvider: provider.id
    };
};

// 鐢熸垚鍞竴ID
const generateId = () => `provider-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// 淇濆瓨璁剧疆锟?localStorage
export const saveSettings = (settings: AppSettings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

export const removeLegacyCredentialsOnce = (): void => {
    if (localStorage.getItem(LEGACY_CREDENTIAL_CLEANUP_KEY) === '1') return;
    LEGACY_CREDENTIAL_KEYS.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(LEGACY_CREDENTIAL_CLEANUP_KEY, '1');
};

// 锟?localStorage 鍔犺浇璁剧疆
export const loadSettings = (): AppSettings | null => {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
        try {
            const settings = JSON.parse(stored) as AppSettings;

            // 鍏煎鎬у鐞嗭細涓虹己灏憈ype鐨勬彁渚涘晢娣诲姞绫诲瀷
            const ensureType = (providers: ApiProvider[]) => {
                return providers.map(p => {
                    if (!(p as any).type) {
                        // 鏅鸿兘鎺ㄦ柇type
                        if (p.baseUrl?.includes('openai.com')) {
                            return { ...p, type: 'openai' as const };
                        }
                        // 榛樿涓篻emini
                        return { ...p, type: 'gemini' as const };
                    }
                    return p;
                });
            };

            // 涓篛penAI鎻愪緵鍟嗘坊鍔犻粯璁ndpoint妯″紡
            const ensureEndpointMode = (providers: ApiProvider[]) => {
                return providers.map(p => {
                    if ((p as any).type === 'openai' && !(p as any).endpointMode) {
                        return { ...p, endpointMode: 'chat' as const };
                    }
                    return p;
                });
            };

            return {
                imageProviders: ensureEndpointMode(ensureType(settings.imageProviders)),
                videoProviders: ensureEndpointMode(ensureType(settings.videoProviders)),
                textProviders: ensureEndpointMode(ensureType(settings.textProviders)),
                audioProviders: ensureEndpointMode(ensureType((settings as any).audioProviders || [])),
                defaultImageProvider: settings.defaultImageProvider,
                defaultVideoProvider: settings.defaultVideoProvider,
                defaultTextProvider: settings.defaultTextProvider,
                defaultAudioProvider: (settings as any).defaultAudioProvider,
                apiRequestMode: (settings as any).apiRequestMode || 'direct-first',
                concurrencyLimit: settings.concurrencyLimit || 15 // 榛樿骞跺彂鏁颁负15
            };
        } catch (e) {
            console.error('Failed to parse settings:', e);
            return null;
        }
    }
    return null;
};

// 鏁版嵁杩佺Щ锛氫粠鏃х殑鍗曚竴API閰嶇疆杩佺Щ鍒版柊鐨勫API鏍煎紡
export const migrateOldSettings = (): AppSettings => {
    const settings: AppSettings = {
        imageProviders: [],
        videoProviders: [],
        textProviders: [],
        audioProviders: []
    };

    // 杩佺Щ鍥惧儚鐢熸垚閰嶇疆
    const oldImageApiKey = localStorage.getItem('gemini_api_key');
    const oldImageBaseUrl = localStorage.getItem('gemini_base_url');
    if (oldImageApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Gemini (Migrated)',
            apiKey: oldImageApiKey,
            baseUrl: oldImageBaseUrl || 'https://generativelanguage.googleapis.com',
            type: 'gemini',
            models: [
                { id: 'gemini-2.0-flash-exp', displayName: 'Gemini 2.0 Flash' },
                { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' }
            ],
            isDefault: true
        };
        settings.imageProviders.push(provider);
        settings.defaultImageProvider = provider.id;
    }

    // 杩佺Щ瑙嗛鐢熸垚閰嶇疆
    const oldVideoApiKey = localStorage.getItem('sora_api_key');
    const oldVideoBaseUrl = localStorage.getItem('sora_base_url');
    if (oldVideoApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Sora (Migrated)',
            apiKey: oldVideoApiKey,
            baseUrl: oldVideoBaseUrl || 'https://api.openai.com',
            type: 'sora',
            models: [
                { id: 'sora-2', displayName: 'Sora 2' },
                { id: 'sora-2-all', displayName: 'Sora 2 All' }
            ],
            isDefault: true
        };
        settings.videoProviders.push(provider);
        settings.defaultVideoProvider = provider.id;
    }

    // 杩佺Щ鏂囨湰鐢熸垚閰嶇疆
    const oldTextApiKey = localStorage.getItem('text_api_key');
    const oldTextBaseUrl = localStorage.getItem('text_base_url');
    if (oldTextApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Gemini (Migrated)',
            apiKey: oldTextApiKey,
            baseUrl: oldTextBaseUrl || 'https://generativelanguage.googleapis.com',
            type: 'gemini',
            models: [
                { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' }
            ],
            isDefault: true
        };
        settings.textProviders.push(provider);
        settings.defaultTextProvider = provider.id;
    }

    const settingsWithComfly = ensureDefaultComflyImageProvider(settings);
    if (settingsWithComfly !== settings) {
        saveSettings(settingsWithComfly);
    }

    return settingsWithComfly;
};

// 鍒濆鍖栬缃細濡傛灉娌℃湁鏂拌缃紝鍒欎粠鏃ч厤缃縼锟?
export const initializeSettings = (): AppSettings => {
    let settings = loadSettings();

    if (!settings) {
        // 灏濊瘯杩佺Щ鏃ч厤锟?
        settings = migrateOldSettings();

        // 濡傛灉杩佺Щ鍚庝粛鐒舵病鏈変换浣曟彁渚涘晢锛屽垱寤虹┖鐨勯粯璁ょ粨锟?
        if (settings.imageProviders.length === 0 &&
            settings.videoProviders.length === 0 &&
            settings.textProviders.length === 0) {
            // 杩斿洖鍒濆棰勮閰嶇疆
            settings = {
                imageProviders: [],
                videoProviders: [],
                audioProviders: [],
                textProviders: [
                    {
                        id: generateId(),
                        name: 'xwang',
                        apiKey: '',
                        baseUrl: 'https://api.xwang.store',
                        type: 'openai',
                        models: [
                            { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
                            { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro' }
                        ],
                        isDefault: true
                    }
                ],
                defaultTextProvider: undefined, // Will be handled by initialization logic if needed
                apiRequestMode: 'direct-first',
                concurrencyLimit: 15 // 榛樿骞跺彂鏁颁负15
            };
        } else {
            // 淇濆瓨杩佺Щ鍚庣殑璁剧疆
            saveSettings(settings);
        }
    }

    if (!settings.audioProviders) {
        settings.audioProviders = [];
    }

    // Ensure xwang provider exists
    const hasXwang = settings.textProviders.some(p => p.baseUrl?.includes('xwang.store') || p.name === 'xwang');
    if (!hasXwang) {
        const xwangProvider: ApiProvider = {
            id: generateId(),
            name: 'xwang',
            apiKey: '',
            baseUrl: 'https://api.xwang.store',
            type: 'openai',
            models: [
                { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
                { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro' }
            ],
            isDefault: false
        };
        settings.textProviders.push(xwangProvider);
        saveSettings(settings); // Persist the addition
    }

    // Seed a default xwang video provider once (user can still delete it later)
    const hasSeededXwangVideo = localStorage.getItem(XWANG_VIDEO_PROVIDER_SEEDED_KEY) === '1';
    const hasXwangVideo = settings.videoProviders.some(
        p => p.baseUrl?.includes('api.xwang.store') || p.name?.toLowerCase() === 'xwang'
    );
    if (!hasSeededXwangVideo && !hasXwangVideo) {
        const xwangVideoProvider: ApiProvider = {
            id: generateId(),
            name: 'xwang',
            apiKey: '',
            baseUrl: 'https://api.xwang.store',
            type: 'sora', // /v1/videos
            models: [
                { id: 'sora-2', displayName: 'Sora 2' }
            ],
            isDefault: settings.videoProviders.length === 0
        };
        settings.videoProviders.push(xwangVideoProvider);
        if (!settings.defaultVideoProvider && xwangVideoProvider.isDefault) {
            settings.defaultVideoProvider = xwangVideoProvider.id;
        }
        saveSettings(settings);
        localStorage.setItem(XWANG_VIDEO_PROVIDER_SEEDED_KEY, '1');
    } else if (hasXwangVideo && !hasSeededXwangVideo) {
        localStorage.setItem(XWANG_VIDEO_PROVIDER_SEEDED_KEY, '1');
    }

    const hasSeededXwangAudio = localStorage.getItem(XWANG_AUDIO_PROVIDER_SEEDED_KEY) === '1';
    const hasXwangAudio = settings.audioProviders.some(
        p => p.baseUrl?.includes('api.xwang.store') || p.name?.toLowerCase() === 'xwang audio'
    );
    if (!hasSeededXwangAudio && !hasXwangAudio) {
        const xwangAudioProvider: ApiProvider = {
            id: generateId(),
            name: 'xwang audio',
            apiKey: '',
            baseUrl: 'https://api.xwang.store',
            type: 'openai',
            endpointMode: 'custom',
            customEndpoint: '/v1/audio/speech',
            models: [
                { id: 'gpt-4o-mini-tts', displayName: 'GPT-4o Mini TTS' }
            ],
            isDefault: true
        };
        settings.audioProviders.push(xwangAudioProvider);
        settings.defaultAudioProvider = xwangAudioProvider.id;
        saveSettings(settings);
        localStorage.setItem(XWANG_AUDIO_PROVIDER_SEEDED_KEY, '1');
    } else if (hasXwangAudio && !hasSeededXwangAudio) {
        localStorage.setItem(XWANG_AUDIO_PROVIDER_SEEDED_KEY, '1');
    }

    return settings;
};

// --- 閰嶇疆瀵煎嚭/瀵煎叆 ---

// 瀵煎嚭閰嶇疆涓篔SON鏂囦欢
export const exportSettings = (settings: AppSettings) => {
    const dataStr = JSON.stringify(settings, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `X-tapnow-settings-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
};

// 浠嶫SON鏂囦欢瀵煎叆閰嶇疆
export const importSettings = (file: File): Promise<AppSettings> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const result = e.target?.result as string;
                const settings = JSON.parse(result) as AppSettings;

                // 鍩烘湰楠岃瘉
                if (!settings.imageProviders || !settings.videoProviders || !settings.textProviders) {
                    reject(new Error("Invalid settings file format"));
                    return;
                }

                // 纭繚鎵€鏈塸rovider閮芥湁type瀛楁
                const ensureType = (providers: any[]) => {
                    return providers.map(p => {
                        if (!p.type) {
                            if (p.baseUrl?.includes('openai.com')) {
                                return { ...p, type: 'openai' as const };
                            }
                            return { ...p, type: 'gemini' as const };
                        }
                        return p;
                    });
                };

                const validatedSettings: AppSettings = {
                    imageProviders: ensureType(settings.imageProviders),
                    videoProviders: ensureType(settings.videoProviders),
                    textProviders: ensureType(settings.textProviders),
                    audioProviders: ensureType((settings as any).audioProviders || []),
                    defaultImageProvider: settings.defaultImageProvider,
                    defaultVideoProvider: settings.defaultVideoProvider,
                    defaultTextProvider: settings.defaultTextProvider,
                    defaultAudioProvider: (settings as any).defaultAudioProvider,
                    apiRequestMode: (settings as any).apiRequestMode || 'direct-first',
                    concurrencyLimit: settings.concurrencyLimit || 15
                };

                resolve(validatedSettings);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
    });
};
